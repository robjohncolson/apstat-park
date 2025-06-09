# apstat-park - Summer Learning Platform

A gamified learning platform for AP Statistics with PICO PARK-inspired design.

## Features

- **Unit-based progression** with locked/unlocked mechanics
- **Mobile-friendly lesson selector** with swipe navigation
- **QR code integration** for mobile access
- **Progress tracking** and bookmarking
- **Keyboard navigation** support
- **Dynamic deadline calculation** based on AP exam date

## Quick Deploy to Vercel

1. **Push your code to GitHub**
2. **Go to [vercel.com](https://vercel.com)**
3. **Sign up/Login with GitHub**
4. **Click "New Project"**
5. **Import your repository**
6. **Deploy!**

The `vercel.json` file is already configured for optimal deployment.

## Local Development

1. Open `index.html` in a web browser
2. Or use a local server: `python -m http.server 8000`
3. Navigate to `http://localhost:8000`

## File Structure

```
├── index.html              # Main app interface
├── unified-lesson.html     # Lesson experience page
├── mobile-lesson.html      # Mobile-specific lesson page
├── js/
│   └── allUnitsData.js    # Course data
├── pdfs/                   # PDF resources
├── vercel.json            # Vercel deployment config
└── README.md              # This file
```

## Deployment URL

After deploying to Vercel, your app will be available at:
`https://your-project-name.vercel.app` 