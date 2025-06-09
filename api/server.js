const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_QACh3gvPt8YN@ep-frosty-waterfall-a8lhnug0-pooler.eastus2.azure.neon.tech/neondb?sslmode=require",
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json());

// Username generation lists
const adjectives = [
    'happy', 'cheerful', 'wise', 'brave', 'calm', 'bright', 'clever', 'gentle', 
    'swift', 'kind', 'bold', 'quick', 'smart', 'cool', 'warm', 'sunny'
];

const animals = [
    'otter', 'panda', 'fox', 'owl', 'cat', 'dog', 'bear', 'wolf', 'hawk', 
    'deer', 'rabbit', 'turtle', 'dolphin', 'seal', 'penguin', 'koala'
];

const plants = [
    'oak', 'maple', 'willow', 'cedar', 'pine', 'sage', 'fern', 'moss', 
    'ivy', 'rose', 'lily', 'iris', 'mint', 'basil', 'lavender', 'bamboo'
];

const foods = [
    'mango', 'honey', 'berry', 'apple', 'lemon', 'peach', 'cocoa', 'mint', 
    'vanilla', 'caramel', 'cinnamon', 'ginger', 'nutmeg', 'papaya', 'kiwi'
];

// Generate random username
function generateUsername() {
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const nouns = [...animals, ...plants, ...foods];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 100);
    return `${adj}${noun}${num}`;
}

// Get or create user
app.post('/api/users/get-or-create', async (req, res) => {
    try {
        console.log('Creating user request received');
        const { username } = req.body;
        
        if (username) {
            console.log('Checking for existing username:', username);
            // Try to get existing user
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            if (result.rows.length > 0) {
                console.log('Found existing user');
                return res.json({ user: result.rows[0] });
            }
        }
        
        // Generate new username if none provided or not found
        let newUsername;
        let attempts = 0;
        
        do {
            newUsername = generateUsername();
            attempts++;
        } while (attempts < 10); // Prevent infinite loop
        
        console.log('Creating new user with username:', newUsername);
        
        // Create new user
        const insertResult = await pool.query(
            'INSERT INTO users (username) VALUES ($1) RETURNING *',
            [newUsername]
        );
        
        console.log('User created successfully:', insertResult.rows[0]);
        res.json({ user: insertResult.rows[0] });
    } catch (error) {
        console.error('Error in get-or-create user:', error);
        console.error('Error details:', {
            message: error.message,
            code: error.code,
            detail: error.detail
        });
        res.status(500).json({ 
            error: error.message,
            code: error.code,
            detail: error.detail
        });
    }
});

// Get user progress
app.get('/api/users/:userId/progress', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM progress WHERE user_id = $1',
            [userId]
        );
        
        res.json({ progress: result.rows });
    } catch (error) {
        console.error('Error getting progress:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sync progress
app.post('/api/users/:userId/progress/sync', async (req, res) => {
    try {
        const { userId } = req.params;
        const { progressData } = req.body;
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            for (const [lessonId, localProgress] of Object.entries(progressData)) {
                // Get existing progress
                const existingResult = await client.query(
                    'SELECT * FROM progress WHERE user_id = $1 AND lesson_id = $2',
                    [userId, lessonId]
                );
                
                if (existingResult.rows.length > 0) {
                    // Merge progress (union of arrays, latest completion)
                    const existing = existingResult.rows[0];
                    const mergedVideos = [...new Set([...existing.videos_watched, ...localProgress.videosWatched])];
                    const mergedQuizzes = [...new Set([...existing.quizzes_completed, ...localProgress.quizzesCompleted])];
                    const lessonCompleted = existing.lesson_completed || localProgress.lessonCompleted;
                    const completedAt = lessonCompleted ? 
                        (localProgress.completedAt && new Date(localProgress.completedAt) > new Date(existing.completed_at) ? 
                         localProgress.completedAt : existing.completed_at) : null;
                    
                    await client.query(
                        `UPDATE progress SET 
                         videos_watched = $3, 
                         quizzes_completed = $4, 
                         lesson_completed = $5, 
                         completed_at = $6,
                         updated_at = NOW()
                         WHERE user_id = $1 AND lesson_id = $2`,
                        [userId, lessonId, mergedVideos, mergedQuizzes, lessonCompleted, completedAt]
                    );
                } else {
                    // Insert new progress
                    await client.query(
                        `INSERT INTO progress (user_id, lesson_id, videos_watched, quizzes_completed, lesson_completed, completed_at)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [userId, lessonId, localProgress.videosWatched, localProgress.quizzesCompleted, 
                         localProgress.lessonCompleted, localProgress.completedAt]
                    );
                }
            }
            
            // Update user's last sync time
            await client.query('UPDATE users SET last_sync = NOW() WHERE id = $1', [userId]);
            
            await client.query('COMMIT');
            
            // Return updated progress
            const finalResult = await client.query(
                'SELECT * FROM progress WHERE user_id = $1',
                [userId]
            );
            
            res.json({ success: true, progress: finalResult.rows });
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('Error syncing progress:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get bookmarks
app.get('/api/users/:userId/bookmarks', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const result = await pool.query(
            'SELECT * FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC',
            [userId]
        );
        
        res.json({ bookmarks: result.rows });
    } catch (error) {
        console.error('Error getting bookmarks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Sync bookmarks
app.post('/api/users/:userId/bookmarks/sync', async (req, res) => {
    try {
        const { userId } = req.params;
        const { bookmarks } = req.body;
        
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');
            
            // Clear existing bookmarks (since we only allow one bookmark at a time)
            await client.query('DELETE FROM bookmarks WHERE user_id = $1', [userId]);
            
            // Insert new bookmark if provided
            if (bookmarks && bookmarks.length > 0) {
                const bookmark = bookmarks[0]; // Only take the latest one
                await client.query(
                    `INSERT INTO bookmarks (user_id, bookmark_type, lesson_id, item_index, item_type, item_title)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [userId, bookmark.type, bookmark.lessonId, bookmark.index, bookmark.itemType, bookmark.title]
                );
            }
            
            await client.query('COMMIT');
            
            // Return updated bookmarks
            const result = await client.query(
                'SELECT * FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC',
                [userId]
            );
            
            res.json({ success: true, bookmarks: result.rows });
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
        
    } catch (error) {
        console.error('Error syncing bookmarks:', error);
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Test database connection on startup
pool.connect((err, client, done) => {
    if (err) {
        console.error('Database connection failed:', err);
    } else {
        console.log('Database connected successfully');
        done();
    }
});

app.listen(port, () => {
    console.log(`APStat Park API running on port ${port}`);
    console.log(`Database URL: ${process.env.DATABASE_URL ? 'Set from environment' : 'Using fallback'}`);
});

module.exports = app; 