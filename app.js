require('dotenv').config();
const express = require('express');
const app = express();
const morgan = require('morgan');
const OpenAI = require('openai');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo'); // Added import

// Set view engine
app.set('view engine', 'ejs');

// Trust proxy when in production (important for cookies when behind a proxy)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  console.log('Trusting proxy in production environment');
}

// Connect to MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/guidancehub';
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: true,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    collectionName: 'sessions'
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production', // Set to true in production with HTTPS
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // Important for cross-site cookies in production
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Passport Configuration
const callbackURL = process.env.NODE_ENV === 'production' 
  ? `${process.env.APP_URL || 'https://pathfinder-krpb.onrender.com'}/auth/google/callback` 
  : 'http://localhost:3000/auth/google/callback';
console.log('Using callbackURL:', callbackURL);

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: callbackURL
}, (accessToken, refreshToken, profile, done) => {
  console.log('Google OAuth profile:', profile);
  // Store more user information for better persistence
  const user = {
    id: profile.id,
    displayName: profile.displayName,
    emails: profile.emails,
    photos: profile.photos,
    provider: profile.provider
  };
  return done(null, user);
}));

passport.serializeUser((user, done) => {
  console.log('Serializing user:', user.id);
  done(null, user);
});

passport.deserializeUser((user, done) => {
  console.log('Deserializing user:', user.id);
  done(null, user);
});

// Middleware
app.use(passport.initialize());
app.use(passport.session());
app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals.isAuthenticated = req.isAuthenticated();
  next();
});

// Debug middleware for static file requests
app.use((req, res, next) => {
  if (req.path.startsWith('/auth.js') || req.path.startsWith('/index.js') || req.path.startsWith('/styles.css')) {
    console.log(`Static resource requested: ${req.path}`);
  }
  next();
});

// Improved static file serving with proper headers for production
app.use(express.static('public', {
  // Set Cache-Control headers
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  // Set proper content types
  setHeaders: (res, path) => {
    if (path.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    } else if (path.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css; charset=UTF-8');
    }
    
    // Add CORS headers in production
    if (process.env.NODE_ENV === 'production') {
      // Allow same-origin and the render.com domain
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
}));

app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth Status Endpoint
app.get('/auth/status', (req, res) => {
  res.json({
    isAuthenticated: req.isAuthenticated(),
    user: req.user
  });
});

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Feedback Model
const feedbackSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  feedback: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});
const Feedback = mongoose.model('Feedback', feedbackSchema);

// Authentication Middleware
const ensureAuthenticatedWeb = (req, res, next) => {
  console.log('User authenticated:', req.isAuthenticated());
  console.log('Session:', req.session);
  console.log('User:', req.user);
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
};

const ensureAuthenticatedApi = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Unauthorized' });
};

// Authentication Routes
app.get('/auth/google',
  (req, res, next) => {
    console.log('Starting Google auth, referrer:', req.headers.referer);
    req.session.returnTo = req.headers.referer || '/'; // Save the original URL
    next();
  },
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    const redirectUrl = req.session.returnTo || '/';
    delete req.session.returnTo; // Clear the saved URL
    
    console.log('Auth successful, user:', req.user?.id);
    console.log('Session after auth:', req.session);
    console.log('Redirecting to:', redirectUrl);
    
    // Save session before redirecting
    req.session.save((err) => {
      if (err) {
        console.error('Error saving session:', err);
      }
      res.redirect(redirectUrl);
    });
  }
);

app.get('/logout', (req, res, next) => {
  // Clear the user from the session
  req.logout((err) => {
    if (err) return next(err);
    
    // Destroy the session
    req.session.destroy((err) => {
      if (err) return next(err);
      
      // Clear the session cookie
      res.clearCookie('connect.sid');
      console.log('User logged out, session destroyed');
      
      // Redirect to home page
      res.redirect('/');
    });
  });
});

// Account Route
app.get('/account', ensureAuthenticatedWeb, (req, res) => {
  res.render('account', { user: req.user });
});

// Saved Advice Route
app.get('/saved-advice', ensureAuthenticatedWeb, async (req, res) => {
  try {
    // If you have a Feedback model that stores saved advice
    const savedAdvice = await Feedback.find({ userId: req.user.id, saved: true }).sort({ createdAt: -1 });
    res.render('saved-advice', { user: req.user, savedAdvice });
  } catch (error) {
    console.error('Error fetching saved advice:', error);
    res.render('saved-advice', { user: req.user, savedAdvice: [] });
  }
});

// Feedback Routes
app.post('/feedback', ensureAuthenticatedApi, async (req, res) => {
  const { feedback } = req.body;
  const newFeedback = new Feedback({
    userId: req.user.id,
    feedback
  });
  try {
    await newFeedback.save();
    res.status(201).json({ message: 'Feedback saved' });
  } catch (error) {
    console.error('Error saving feedback:', error);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

app.get('/feedback', ensureAuthenticatedApi, async (req, res) => {
  try {
    const feedbackList = await Feedback.find({ userId: req.user.id });
    res.json(feedbackList);
  } catch (error) {
    console.error('Error retrieving feedback:', error);
    res.status(500).json({ error: 'Failed to retrieve feedback' });
  }
});

// Conversations Page Route
app.get('/conversations', ensureAuthenticatedWeb, async (req, res) => {
  try {
    console.log('User ID:', req.user ? req.user.id : 'Not authenticated');
    const feedbackList = await Feedback.find({ userId: req.user ? req.user.id : '' })
      .sort({ timestamp: -1 });
    console.log('Feedback found:', feedbackList);
    res.render('conversations', { feedback: feedbackList });
  } catch (error) {
    console.error('Error loading conversations:', error);
    res.status(500).send('Server error');
  }
});

// Other Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/begin', (req, res) => {
  res.render('begin');
});

app.get('/about', (req, res) => {
  res.render('about');
});

app.get('/login', (req, res) => {
  res.render('login');
});

app.get('/home', (req, res) => {
  res.render('index');
});

app.get('/about-us', (req, res) => {
  res.redirect('/about');
});

app.get('/contact', (req, res) => {
  res.render('contact');
});

app.get('/create', (req, res) => {
  res.render('create');
});

app.post('/get-questions', ensureAuthenticatedApi, async (req, res) => {
  const { category, advice_style, mood } = req.body;
  if (!category || !advice_style) {
    return res.status(400).json({ error: 'Category and advice style are required' });
  }

  const prompt = `You are an expert life coach tasked with generating thoughtful, open-ended questions to help a user gain personalized advice. Based on the category '${category}', the advice style '${advice_style}' (e.g., philosophical, practical, empathetic, or humorous), and the user's current mood '${mood}' (e.g., overwhelmed, motivated, confused, hopeful, stressed), craft exactly three open-ended questions that are highly relevant to the user's situation and mood. The questions should encourage reflection and align with the specified advice style. List the questions in the format: 1., 2., 3. Do not include any introductory text, explanations, or extra lines—just the three numbered questions.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 150
    });
    const questionsText = completion.choices[0].message.content;
    const questions = questionsText
      .split('\n')
      .filter((line) => line.match(/^\d\./))
      .map((line) => line.replace(/^\d\.\s*/, '').trim());
    if (questions.length !== 3) throw new Error('Did not receive exactly 3 questions');
    res.json({ questions });
  } catch (error) {
    console.error('Error in /get-questions:', error);
    res.status(500).json({ error: 'Failed to get questions' });
  }
});

app.post('/get-advice', ensureAuthenticatedApi, async (req, res) => {
  const { category, advice_style, mood, question0, question1, question2, answer0, answer1, answer2 } = req.body;
  if (!category || !advice_style) {
    return res.status(400).json({ error: 'Category and advice style are required' });
  }

  const qaPairs = [
    { question: question0, answer: answer0 },
    { question: question1, answer: answer1 },
    { question: question2, answer: answer2 },
  ];
  let qaText = '';
  qaPairs.forEach((qa, index) => {
    qaText += `Question ${index + 1}: ${qa.question}\nAnswer ${index + 1}: ${qa.answer}\n`;
  });
  const prompt = `Given the category '${category}', the advice style '${advice_style}', the user's current mood '${mood}', and the following questions and answers:\n${qaText}Please provide detailed and personalized advice in a concise paragraph.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    const advice = completion.choices[0].message.content;

    const newFeedback = new Feedback({
      userId: req.user.id,
      feedback: advice,
      timestamp: new Date()
    });
    await newFeedback.save();
    console.log('Feedback saved:', newFeedback);

    res.json({ advice });
  } catch (error) {
    console.error('Error in /get-advice:', error);
    res.status(500).json({ error: 'Failed to get advice' });
  }
});

// 404 Handler
app.use((req, res) => {
  res.status(404).render('404');
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});