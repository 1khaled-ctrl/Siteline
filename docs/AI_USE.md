# How we used AI

**Code.** We wrote the code with Claude Code in six sessions, one per role. A named team member reviewed every merge. People wrote and checked the validation tests.

**Product.** The in-app copilot uses the Claude API: Claude Sonnet 5.5 for chat and tools, and Claude Haiku 5.5 for small side jobs. The copilot only explains results from our own calculations, and it shows the source of every number.

**Content.** The submission contains no AI-generated images or video footage. A native speaker reviewed all AI-assisted text, such as the translations and the glossary.

**Data.** Everything comes from the sources listed in CREDITS.md. Nothing is invented.

Commits written by Claude carry a `Co-Authored-By` trailer, so `git log` shows which code was AI-assisted.

| Role                | Reviewer |
| ------------------- | -------- |
| 3D world            |          |
| Orbits              |          |
| Terrain and light   |          |
| Data and missions   |          |
| Interface           |          |
| Copilot and quality |          |
