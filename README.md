# APStat Park - Summer Learning Platform

A gamified learning platform for AP Statistics with cross-device progress synchronization.

## Features

- 📚 **78 Lessons** across 6 units of AP Statistics content
- 🎮 **Game-style Interface** with PICO PARK inspired design
- 📱 **Mobile & Desktop Support** with responsive design
- 🔄 **Cross-device Sync** with Neon PostgreSQL backend
- 📊 **Progress Tracking** with automatic lesson unlocking
- 🔖 **Smart Bookmarks** for videos and quizzes
- 🤖 **AI Integration** with Grok for quiz help
- ⚡ **Offline Support** with background synchronization

## Quick Start

### 1. Database Setup

1. **Create a Neon database**:
   - Go to [Neon Console](https://console.neon.tech)
   - Create a new project
   - Copy your connection string

2. **Run the database schema**:
   ```sql
   -- Copy and paste the contents of database/schema.sql
   -- into your Neon SQL Editor
   ```

### 2. API Server Setup

1. **Install dependencies**:
   ```bash
   cd api
   npm install
   ```

2. **Update connection string** in `api/server.js`:
   ```javascript
   // Replace with your Neon connection string
   const pool = new Pool({
       connectionString: "your-neon-connection-string-here",
       ssl: { rejectUnauthorized: false }
   });
   ```

3. **Start the API server**:
   ```bash
   npm start
   # or for development:
   npm run dev
   ```

### 3. Frontend Setup

1. **Update API URL** in `js/syncManager.js`:
   ```javascript
   this.apiBaseUrl = 'http://your-api-server-url/api';
   ```

2. **Serve the frontend**:
   - For development: Use any local server (Live Server, Python's `http.server`, etc.)
   - For production: Deploy to Netlify, Vercel, or any static hosting

## Database Schema

The app uses three main tables:

- **`users`**: Student accounts with auto-generated usernames
- **`progress`**: Lesson completion tracking with video/quiz progress
- **`bookmarks`**: Student bookmarks for quick access

## Sync Strategy

- **Quick Sync**: 3-second timeout for video/quiz completions
- **Persistent Sync**: 10-second timeout with retries for lesson completions
- **Background Sync**: Non-blocking sync on app load
- **Conflict Resolution**: "Most progress wins" with union merging

## Username Generation

Auto-generated usernames follow the pattern: `{adjective}{noun}{number}`

Examples: `happyotter42`, `wisemango73`, `brightsage15`

## Development

### File Structure
```
├── index.html              # Main app interface
├── unified-lesson.html     # Lesson experience
├── mobile-lesson.html      # Mobile-specific lesson view
├── js/
│   ├── allUnitsData.js     # Lesson content data
│   └── syncManager.js      # Database sync logic
├── api/
│   ├── server.js           # Express API server
│   └── package.json        # API dependencies
└── database/
    └── schema.sql          # Database schema
```

### API Endpoints

- `POST /api/users/get-or-create` - Get or create user
- `GET /api/users/:userId/progress` - Get user progress
- `POST /api/users/:userId/progress/sync` - Sync progress data
- `GET /api/users/:userId/bookmarks` - Get bookmarks
- `POST /api/users/:userId/bookmarks/sync` - Sync bookmarks

### Local Development

1. **API Server**: `cd api && npm run dev`
2. **Frontend**: Serve with any static server on port 3001+ (to avoid API port conflict)
3. **Database**: Use Neon's online SQL editor for schema changes

## Deployment

### Option 1: Separate Hosting
- **API**: Deploy to Railway, Render, or Heroku
- **Frontend**: Deploy to Netlify or Vercel
- **Database**: Neon (already cloud-hosted)

### Option 2: Full-Stack Platform
- Deploy both API and frontend to Railway or Render

### Environment Variables

For production, set these in your API hosting environment:

```bash
DATABASE_URL=your-neon-connection-string
PORT=3000
NODE_ENV=production
```

## Features in Detail

### Cross-Device Sync
- Students can start on mobile, continue on laptop
- Progress automatically merges (union of completed items)
- Bookmarks sync across devices
- Offline mode when network unavailable

### Progress Tracking
- Sequential lesson unlocking
- Video completion tracking
- Quiz attempt tracking
- Dynamic deadline calculation based on remaining content

### Mobile Experience
- QR codes for easy mobile access
- Touch-optimized interface
- Swipe navigation
- Mobile-specific lesson view

## Troubleshooting

### Common Issues

1. **API Connection Failed**:
   - Check that API server is running
   - Verify the `apiBaseUrl` in `syncManager.js`
   - Check CORS settings

2. **Database Connection Error**:
   - Verify Neon connection string
   - Ensure database schema is created
   - Check SSL settings

3. **Sync Not Working**:
   - Check browser console for errors
   - Verify user is created in database
   - Test API endpoints directly

### Debug Mode

Enable detailed logging by adding to browser console:
```javascript
localStorage.setItem('debug', 'true');
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Test both online and offline functionality
4. Ensure mobile compatibility
5. Submit a pull request

## License

MIT License - feel free to use for educational purposes. 