// APStat Park Sync Manager
// Handles synchronization between localStorage and database

class SyncManager {
    constructor() {
        this.apiBaseUrl = 'https://apstat-park-api.up.railway.app'; // Replace with your actual API URL
        this.currentUser = null;
        this.syncInProgress = false;
        this.offlineMode = false;
        
        // Initialize user on creation
        this.initializeUser();
    }

    // Initialize or get existing user
    async initializeUser() {
        try {
            // Check if we have a stored user
            const storedUser = localStorage.getItem('apstat_user');
            if (storedUser) {
                this.currentUser = JSON.parse(storedUser);
                console.log('Loaded existing user:', this.currentUser.username);
                
                // Try to sync in background (non-blocking)
                this.backgroundSync();
                return this.currentUser;
            }

            // Try to get or create a new user
            const response = await this.fetchWithTimeout('/users/get-or-create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            }, 5000);

            if (response.ok) {
                const data = await response.json();
                this.currentUser = data.user;
                localStorage.setItem('apstat_user', JSON.stringify(this.currentUser));
                console.log('Created new user:', this.currentUser.username);
                
                // Initial sync
                this.backgroundSync();
                return this.currentUser;
            } else {
                throw new Error('Failed to create user');
            }
        } catch (error) {
            console.warn('Failed to initialize user online, using offline mode:', error);
            this.offlineMode = true;
            
            // Create temporary offline user
            this.currentUser = {
                id: 'offline',
                username: 'offline-user',
                offline: true
            };
            
            return this.currentUser;
        }
    }

    // Get current user info (for displaying username)
    getCurrentUser() {
        return this.currentUser;
    }

    // Background sync (non-blocking)
    async backgroundSync() {
        if (this.syncInProgress || this.offlineMode) return;
        
        try {
            console.log('Starting background sync...');
            await Promise.race([
                this.fullSync(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Sync timeout')), 10000))
            ]);
            console.log('Background sync completed');
        } catch (error) {
            console.warn('Background sync failed:', error);
            // Don't set offline mode for background sync failures
        }
    }

    // Quick sync for individual actions (video/quiz completion)
    async quickSync(type, data) {
        if (this.syncInProgress || this.offlineMode) return { success: false, reason: 'offline' };
        
        try {
            const result = await Promise.race([
                this.syncData(type, data),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Quick sync timeout')), 3000))
            ]);
            return { success: true, data: result };
        } catch (error) {
            console.warn('Quick sync failed:', error);
            return { success: false, reason: 'timeout' };
        }
    }

    // Persistent sync for lesson completion
    async persistentSync(type, data) {
        if (this.offlineMode) return { success: false, reason: 'offline' };
        
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            try {
                this.syncInProgress = true;
                const result = await Promise.race([
                    this.syncData(type, data),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Persistent sync timeout')), 10000))
                ]);
                
                this.syncInProgress = false;
                return { success: true, data: result };
            } catch (error) {
                attempts++;
                console.warn(`Persistent sync attempt ${attempts} failed:`, error);
                
                if (attempts < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempts)); // Exponential backoff
                }
            }
        }
        
        this.syncInProgress = false;
        return { success: false, reason: 'max_attempts_reached' };
    }

    // Full sync (used for background sync)
    async fullSync() {
        if (!this.currentUser || this.currentUser.offline) return;
        
        this.syncInProgress = true;
        
        try {
            // Sync progress
            await this.syncProgress();
            
            // Sync bookmarks
            await this.syncBookmarks();
            
            console.log('Full sync completed successfully');
        } finally {
            this.syncInProgress = false;
        }
    }

    // Sync progress data
    async syncProgress() {
        if (!this.currentUser || this.currentUser.offline) return;
        
        // Get local progress
        const localProgress = this.getLocalProgressForSync();
        
        const response = await this.fetchWithTimeout(`/users/${this.currentUser.id}/progress/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ progressData: localProgress })
        });
        
        if (!response.ok) throw new Error('Progress sync failed');
        
        const data = await response.json();
        
        // Update local storage with merged data
        this.updateLocalProgressFromSync(data.progress);
        
        return data;
    }

    // Sync bookmarks
    async syncBookmarks() {
        if (!this.currentUser || this.currentUser.offline) return;
        
        // Get local bookmarks
        const localBookmarks = this.getLocalBookmarksForSync();
        
        const response = await this.fetchWithTimeout(`/users/${this.currentUser.id}/bookmarks/sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookmarks: localBookmarks })
        });
        
        if (!response.ok) throw new Error('Bookmark sync failed');
        
        const data = await response.json();
        
        // Update local storage with synced bookmarks
        this.updateLocalBookmarksFromSync(data.bookmarks);
        
        return data;
    }

    // Generic sync data method
    async syncData(type, data) {
        switch (type) {
            case 'progress':
                return await this.syncProgress();
            case 'bookmarks':
                return await this.syncBookmarks();
            default:
                throw new Error(`Unknown sync type: ${type}`);
        }
    }

    // Helper: Get local progress in sync format
    getLocalProgressForSync() {
        const progressData = {};
        
        // Get main app progress
        const saved = localStorage.getItem('apStatsProgress');
        if (saved) {
            const mainProgress = JSON.parse(saved);
            
            // Convert completed lessons to individual progress entries
            for (const lessonId of mainProgress.completedLessons || []) {
                progressData[lessonId] = {
                    lessonCompleted: true,
                    completedAt: new Date().toISOString(),
                    videosWatched: [],
                    quizzesCompleted: []
                };
            }
        }
        
        // Get detailed lesson progress
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith('lesson_progress_')) {
                const lessonId = key.replace('lesson_progress_', '');
                const lessonProgress = JSON.parse(localStorage.getItem(key));
                
                if (!progressData[lessonId]) {
                    progressData[lessonId] = {};
                }
                
                Object.assign(progressData[lessonId], {
                    videosWatched: lessonProgress.videosWatched || [],
                    quizzesCompleted: lessonProgress.quizzesCompleted || [],
                    lessonCompleted: lessonProgress.lessonCompleted || false
                });
            }
        }
        
        return progressData;
    }

    // Helper: Update local progress from sync
    updateLocalProgressFromSync(serverProgress) {
        const completedLessons = [];
        
        for (const progress of serverProgress) {
            // Update detailed lesson progress
            localStorage.setItem(`lesson_progress_${progress.lesson_id}`, JSON.stringify({
                videosWatched: progress.videos_watched || [],
                quizzesCompleted: progress.quizzes_completed || [],
                lessonCompleted: progress.lesson_completed || false
            }));
            
            // Collect completed lessons
            if (progress.lesson_completed) {
                completedLessons.push(progress.lesson_id);
            }
        }
        
        // Update main app progress
        const mainProgress = {
            completedLessons: completedLessons,
            currentLesson: completedLessons.length > 0 ? completedLessons[completedLessons.length - 1] : '1-1'
        };
        
        localStorage.setItem('apStatsProgress', JSON.stringify(mainProgress));
    }

    // Helper: Get local bookmarks in sync format
    getLocalBookmarksForSync() {
        const bookmarks = [];
        
        // Get lesson bookmarks
        const lessonBookmarks = JSON.parse(localStorage.getItem('bookmarked_lessons') || '[]');
        for (const lessonId of lessonBookmarks) {
            bookmarks.push({
                type: 'lesson',
                lessonId: lessonId
            });
        }
        
        // Get item bookmarks
        const itemBookmarks = JSON.parse(localStorage.getItem('item_bookmarks') || '[]');
        for (const item of itemBookmarks) {
            bookmarks.push({
                type: 'item',
                lessonId: item.lessonId,
                index: item.index,
                itemType: item.type,
                title: item.title
            });
        }
        
        return bookmarks;
    }

    // Helper: Update local bookmarks from sync
    updateLocalBookmarksFromSync(serverBookmarks) {
        const lessonBookmarks = [];
        const itemBookmarks = [];
        
        for (const bookmark of serverBookmarks) {
            if (bookmark.bookmark_type === 'lesson') {
                lessonBookmarks.push(bookmark.lesson_id);
            } else if (bookmark.bookmark_type === 'item') {
                itemBookmarks.push({
                    lessonId: bookmark.lesson_id,
                    type: bookmark.item_type,
                    index: bookmark.item_index,
                    title: bookmark.item_title
                });
            }
        }
        
        // Update local storage
        localStorage.setItem('bookmarked_lessons', JSON.stringify(lessonBookmarks));
        localStorage.setItem('item_bookmarks', JSON.stringify(itemBookmarks));
    }

    // Helper: Fetch with timeout
    async fetchWithTimeout(endpoint, options, timeout = 5000) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(this.apiBaseUrl + endpoint, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (error) {
            clearTimeout(id);
            throw error;
        }
    }

    // Public method to trigger sync for external use
    async triggerSync(type = 'full', data = null) {
        if (type === 'quick') {
            return await this.quickSync('progress', data);
        } else if (type === 'persistent') {
            return await this.persistentSync('progress', data);
        } else {
            return await this.fullSync();
        }
    }
    
    // Check if online/offline
    isOnline() {
        return !this.offlineMode && navigator.onLine;
    }
}

// Create global sync manager instance
window.syncManager = new SyncManager(); 