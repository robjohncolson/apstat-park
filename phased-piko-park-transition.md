Okay, Hajimemashou! This is an exciting redesign. I understand the desire for a more engaging, game-like progression, and Pico Park is a great inspiration for that kind of clear, sequential, and cooperative (even if single-player here) feel.

First, let me make sure I grasp the core of Pico Park's relevant UI/UX:

Level Select (within a World): You see a map or a series of icons/doors representing individual levels within a "world." Completed levels are often visually distinct from locked or available-but-not-yet-played levels. You typically have to beat level N to unlock level N+1.

World Select: A higher-level screen where you choose between different "worlds" (which themselves contain multiple levels). Again, World X might only unlock after World X-1 is complete.

Gameplay Screen: The actual level/gameplay takes up the full focus.

Translating this to your AP Stats app:

"Level" = A single Topic (e.g., Topic 1.1, Topic 1.2). This is where students watch videos, download PDFs, and mark items complete.

"World" = A Unit (e.g., Unit 1, Unit 2). This screen will show all topics (levels) within that unit.

"World Select" = Unit Selection Screen. This shows all 9 units.

Your core ideas:

Sequential Lessons (Topics): Must complete Topic 1.1 before 1.2 opens.

Sequential Units (Worlds): Must complete all of Unit 1 before Unit 2 opens.

Lesson View: Full-screen focus on the current topic's materials (videos, PDFs, completion button).

Unit View (World Map): Visual grid/row of boxes for topics within the current unit (e.g., "1.1", "1.2"). Shows completed/current/locked status. Arrow keys (or buttons) to navigate to the next available topic. Unit name prominently displayed.

World Select View: Boxes for each of the 9 Units, showing locked/unlocked/completed status. Click to enter a Unit View.

Navigation:

World Select -> (click Unit) -> Unit View

Unit View -> (click Topic or "Start Next Topic") -> Lesson View

Lesson View -> (click "Complete Topic") -> Unit View (next topic is now current)

Unit View -> (click "Back to Units" button) -> World Select

This is a significant but very cool shift! The existing tabbed interface will largely be replaced or its content re-contextualized.

Here's a phased strategy to implement these changes, designed to be digestible for Claude:

Phased Redesign Strategy: AP Stats "Pico Park" UI

Goal: Transform the existing AP Statistics learning platform into a sequential, level-based experience inspired by Pico Park, focusing on one lesson (topic) at a time, within units (worlds).

Core Data Structure: ALL_UNITS_DATA from allUnitsData.js will remain central. We'll rely on its structure of units containing topics, and topics containing videos/quizzes.

Phase 0: Pre-computation & State Management Setup

Objective: Establish the foundational JavaScript state and logic needed for the new UI paradigm before touching the DOM significantly.

Actions:

Identify Key State Variables:

currentView: String (e.g., 'worldSelect', 'unitView', 'lessonView').

currentUnitId: String (e.g., '1', '2'). This already exists (currentSelectedUnitId).

currentTopicId: String (e.g., '1-1', '1-2').

unlockedUnits: Array of unit IDs that the user has unlocked (e.g., ['1', '2']). Persist in localStorage.

completedTopicsPerUnit: Object { unitId: [topicId1, topicId2], ... }. This can be derived from existing apStatsUnitXProgress or Supabase.

Helper Functions (Logic):

getUnitData(unitId): Returns the object for a specific unit from ALL_UNITS_DATA.

getTopicData(unitId, topicId): Returns data for a specific topic.

isTopicComplete(unitId, topicId): Checks if all videos/quizzes for a topic are marked complete (leverage existing logic).

isUnitComplete(unitId): Checks if all topics (including capstone) in a unit are complete.

getNextTopic(unitId, currentTopicId): Returns the ID of the next topic in the unit, or null if currentTopicId is the last.

getFirstIncompleteTopic(unitId): Finds the first topic in a unit that isn't complete.

unlockNextUnit(): If current unit is complete, add next unit ID to unlockedUnits and save.

Initial State Load:

On DOMContentLoaded, load unlockedUnits from localStorage. If empty, default to ['1'].

Determine initial currentUnitId (first unlocked unit or last worked-on unlocked unit).

Determine initial currentTopicId (first incomplete topic in currentUnitId).

Set currentView (e.g., 'unitView' if only unit 1 is unlocked, 'worldSelect' otherwise).

Phase 1: The "Lesson View" (Full-Screen Topic View)

Objective: Create the primary screen where students interact with a single topic's materials. This will replace the main content area when a lesson is active.

DOM Changes:

In index.html, create a new top-level div container, e.g., <div id="lesson-view-container" class="hidden w-full h-screen p-8"></div>.

The existing tabbed interface (<div class="flex mb-0 border-b ..."> and <div class="bg-white rounded-b-lg shadow-md p-6">) will eventually be hidden or removed when lesson-view-container is active.

JavaScript Logic:

renderLessonView(unitId, topicId) function:

Retrieves topic data using getTopicData(unitId, topicId).

Dynamically populates #lesson-view-container with:

Topic Name (topic.name) and Description (topic.description).

Video links (from topic.videos) with checkboxes and bookmark buttons (reuse createTopicCard's item rendering logic internally, but styled for full screen). Each video/quiz item should still use handleItemCompletionChange.

Quiz PDF links (from topic.quizzes) with checkboxes and bookmark buttons.

A prominent "Mark Lesson Complete & Continue" button.

"Mark Lesson Complete & Continue" Button Logic:

Calls existing markTopicAsCompleted(topicId).

Saves progress (saveTopicProgress()).

Calls checkDailyQuotaCompletion() and updateQuotaMetVisualIndicator().

Determines the next topic. If current topic was capstone and unit is now complete, call unlockNextUnit().

Updates state: currentTopicId to next topic or first topic of next unit.

Changes currentView to 'unitView'.

Calls a new main renderApp() function (see Phase 4) to update the visible screen.

Styling: Simple, clear, focused. Ensure it's usable on various screen sizes.

Phase 2: The "Unit View" (World Map for a Single Unit)

Objective: Create a screen that visually represents all topics within the currently selected unit.

DOM Changes:

Create <div id="unit-view-container" class="hidden p-8"></div>.

JavaScript Logic:

renderUnitView(unitId) function:

Retrieves unit data.

Displays Unit Name (unit.displayName) and Exam Weight prominently.

Dynamically creates a grid/row of "topic boxes" inside #unit-view-container. Each box represents a topic.

Topic Box Content: Topic number (e.g., "1.1" or just "1", "2" sequentially within the unit).

Topic Box Styling/State:

Locked: If previous topic in sequence is not complete (grayed out, unclickable).

Completed: If isTopicComplete(unitId, topic.id) is true (e.g., green checkmark, distinct background). Clickable to review (re-opens Lesson View).

Current/Next: If it's the firstIncompleteTopic(unitId) (e.g., highlighted, pulsing). This is the primary clickable "Play" box.

Adds a "Back to Units" button (if more than one unit is unlocked).

Adds on-screen "Previous Topic" / "Next Topic" buttons (or implement arrow key navigation) to visually shift focus to the next available (unlocked) topic box within the Unit View. This is primarily for navigating the map, not for gameplay.

Topic Box Click Logic:

If topic is unlocked:

Set currentTopicId to the clicked topic's ID.

Set currentView to 'lessonView'.

Call renderApp().

"Back to Units" Button Logic:

Set currentView to 'worldSelect'.

Call renderApp().

Styling: Clean, map-like. Boxes should clearly indicate status.

Phase 3: The "World Select View" (Unit Selection Screen)

Objective: Create a screen for selecting which Unit (World) to enter.

DOM Changes:

Create <div id="world-select-container" class="hidden p-8"></div>.

JavaScript Logic:

renderWorldSelectView() function:

Iterates through ALL_UNITS_DATA.

For each unit, creates a "unit box" in #world-select-container.

Unit Box Content: Unit Number and unit.displayName.

Unit Box Styling/State:

Locked: If unitId is not in unlockedUnits (grayed out, unclickable).

Completed: If isUnitComplete(unitId) is true (e.g., gold star, distinct background).

Available: If unlocked and not complete (standard appearance).

No "Back" button from here (this is the top level).

Unit Box Click Logic:

If unit is unlocked:

Set currentUnitId to the clicked unit's ID.

Set currentTopicId to firstIncompleteTopic(currentUnitId) or the first topic if unit is already complete (for review).

Set currentView to 'unitView'.

Call renderApp().

Styling: Overview map style. Unit boxes should be larger and more prominent than topic boxes.

Phase 4: Main Application Structure & Navigation

Objective: Restructure index.html and JS to manage the three new views and integrate persistent elements.

DOM Changes (index.html):

Simplify Body:

<body class="bg-gray-100 min-h-screen">
    <div id="persistent-header" class="fixed top-0 left-0 right-0 z-50 bg-white shadow-md p-2 flex justify-between items-center print:hidden">
        <!-- Global Bookmark Indicator Placeholder (keep) -->
        <!-- Button to Open Grok Prompt (new) -->
        <!-- Button to View Overall Progress (new) -->
    </div>

    <main id="app-container" class="pt-16"> <!-- Adjust pt based on header height -->
        <div id="world-select-container" class="view-screen hidden p-8"></div>
        <div id="unit-view-container" class="view-screen hidden p-8"></div>
        <div id="lesson-view-container" class="view-screen hidden w-full p-4 md:p-8"></div>
    </main>

    <div id="grok-prompt-modal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-[60] flex items-center justify-center">
        <!-- Content for Grok Prompt similar to existing 'content-grok-prompt' tab but styled for modal -->
    </div>
    <div id="overall-progress-modal" class="fixed inset-0 bg-black bg-opacity-50 hidden z-[60] flex items-center justify-center">
        <!-- Content for Overall Progress similar to existing 'content-overall-progress' tab but styled for modal -->
    </div>
    <!-- Existing scripts, QR code etc. at the bottom -->
</body>


Add basic CSS for .view-screen.hidden { display: none; } and .view-screen.active { display: block; /* or flex, grid etc. */ }.

JavaScript Logic:

renderApp() main function:

This function is called whenever currentView, currentUnitId, or currentTopicId changes.

Hides all .view-screen divs.

Based on currentView:

If 'worldSelect': Calls renderWorldSelectView() and shows #world-select-container.

If 'unitView': Calls renderUnitView(currentUnitId) and shows #unit-view-container.

If 'lessonView': Calls renderLessonView(currentUnitId, currentTopicId) and shows #lesson-view-container.

Calls updatePageTitles() (existing function, adapt if needed).

Calls displayGlobalBookmarkIndicator() to ensure it's up-to-date.

Persistent Header Buttons:

Grok Prompt Button: Toggles visibility of #grok-prompt-modal. The modal would contain the prompt text, copy button, links to current topic PDFs (dynamically updated based on currentUnitId and currentTopicId if in Lesson View, or first incomplete otherwise).

Overall Progress Button: Toggles visibility of #overall-progress-modal. This modal would host the content from the current "Overall Progress" tab (dot plot, peer quotas, etc.).

Initialization on DOMContentLoaded:

Perform Phase 0 logic (load state).

Call identifyUser().

Call renderApp() to display the initial view.

Initialize event listeners for persistent header buttons.

Call updateQuotaMetVisualIndicator() and other initial setup functions like syncOfflineQueue.

Phase 5: Integrating Remaining Features & Refinements

Objective: Ensure all critical existing functionality is preserved or gracefully adapted, and polish the UI/UX.

Grok Prompt & Overall Progress Modals:

Ensure the content within these modals (previously tabs) is functional and well-styled.

The "Current Topic Materials" in the Grok prompt modal needs to dynamically reflect currentUnitId and currentTopicId if a lesson is active, or the next logical topic otherwise.

The displayOverallProgress() function and its sub-functions (displaySupabaseDotPlot, etc.) will populate the #overall-progress-modal.

Bookmarks:

Ensure bookmark buttons on videos/PDFs in the Lesson View are correctly implemented using data-bookmark-* attributes.

displayGlobalBookmarkIndicator() should continue to work in the persistent header.

Quota System:

The global green tint (body.quota-met-today) should remain functional.

checkDailyQuotaCompletion() logic still applies.

Removed/Replaced Elements:

The main tab navigation (#tab-learning-flow, etc.) is removed.

The old unit tab navigation (#unit-navigation) is replaced by the World Select view.

The old progress bar and topic select dropdown above the tabs are replaced by the visual cues in Unit View / World Select.

Learning Flow and Flowchart tabs: Decide if this content needs a new home (e.g., a "Help" modal) or if it's deprecated. The React APStatLearningFlow component and Mermaid flowchart are specific to these.

Styling & UX:

Apply consistent styling inspired by Pico Park (simple, clear, good visual feedback for states).

Ensure good responsiveness for all views and modals.

Implement keyboard navigation (arrow keys for Unit View focus, Enter to select).

Add subtle animations/transitions for view changes if desired.

Testing: Thoroughly test all navigation paths, completion logic, progress saving/loading, unit/topic unlocking, and Supabase integrations.

Key Functions to Adapt/Reuse:

ALL_UNITS_DATA (central data)

loadTopicProgress, saveTopicProgress (state persistence)

markTopicAsCompleted, markVideoComplete, markQuizComplete, handleItemCompletionChange (core completion logic, used within Lesson View)

checkDailyQuotaCompletion, updateQuotaMetVisualIndicator (quota system)

identifyUser, Supabase functions (backend integration)

displayGlobalBookmarkIndicator, bookmarking functions (bookmarking system)

updatePageTitles

Elements of createTopicCard (for rendering items in Lesson View)

Content generation logic for Grok prompt and Overall Progress (for modals)

Key Elements to Remove/Hide:

Existing tab navigation (.tab-button, .tab-content).

Unit selection buttons (.unit-tab).

The div#learning-flow-app and associated React component (unless re-purposed for a help section).

The Mermaid flowchart div#flowchart (unless re-purposed).

The progress bar and topic select dropdown currently above the tabs.

This phased approach should allow for manageable chunks of work. Each phase builds upon the previous, gradually transforming the application. Good luck!