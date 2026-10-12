---
name: teach
description: Teach the user a new skill or concept over multiple sessions, grounded in why they want to learn it, with lessons, reference sheets and checks for understanding.
disable-model-invocation: true
argument-hint: "What would you like to learn about?"
metadata:
  credits: "Adapted from Matt Pocock's teach skill, https://github.com/mattpocock/skills (MIT)"
---

The user has asked you to teach them something. This is a stateful request: they intend to learn the topic over multiple sessions.

Paths to `references/` below are relative to this skill's directory; resolve them to absolute paths before reading. Every other path is relative to the teaching workspace.

## Teaching workspace

A teaching workspace is one folder per topic. Find or create it in this order:

1. **The current directory**, if it already is one (it holds a `MISSION.md`), or if the user ran this skill in a folder they set aside for the topic.
2. **A folder the user names.**
3. **Otherwise, the scratch folder.** This repository's agent configuration should have been provided to you (the `## Agent skills` block pointing at `docs/agents/`); `docs/agents/workspace.md` names the scratch folder. If it is missing, use the default `.scratchpad/` and suggest the user run the `setup-aclarify-skills` skill. Create `<scratch>/learning/<topic-slug>/`. The scratch folder is usually git-ignored, which suits learning that is personal rather than project context; tell the user where the workspace lives so they can find it again.

Create the folder on first use, never ahead of it.

The state of their learning is captured in that folder in several files:

- `MISSION.md`: a document capturing the _reason_ the user is interested in the topic. This should be used to ground all teaching. Use the format in [references/MISSION-FORMAT.md](references/MISSION-FORMAT.md).
- `./reference/*.html`: a directory of reference materials. These are the compressed learnings from the lessons: cheat sheets, reference algorithms, syntax, yoga poses, glossaries. They are the raw units of learning. They should be beautiful documents which print out well, and are designed for quick reference. A glossary is the one with a fixed format: [references/GLOSSARY-FORMAT.md](references/GLOSSARY-FORMAT.md).
- `RESOURCES.md`: a list of resources which can be explored to ground your teaching in contextual knowledge, or to acquire knowledge and wisdom. Use the format in [references/RESOURCES-FORMAT.md](references/RESOURCES-FORMAT.md).
- `./learning-records/*.md`: a directory of learning records, which capture what the user has learned. These are loosely equivalent to decision records in software development: they capture non-obvious lessons and key insights that may need to be revised later, or drive future sessions. These should be used to calculate the zone of proximal development. They are titled `0001-<dash-case-name>.md`, where the number increments each time. Use the format in [references/LEARNING-RECORD-FORMAT.md](references/LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html`: a directory of lessons. A **lesson** is a single, self-contained HTML output that teaches one tightly-scoped thing tied to the mission. This is the primary unit of teaching in this workspace.
- `./assets/*`: reusable **components** shared across lessons. See the Assets section of [references/lesson-craft.md](references/lesson-craft.md).
- `NOTES.md`: a scratchpad for you to jot down user preferences, or working notes.

## The mission

Every lesson should be tied into the mission: the reason that the user is interested in learning about the topic.

If the user is unclear about the mission, or the `MISSION.md` is not populated, your first job should be to question the user on why they want to learn this.

Failing to understand the mission will mean knowledge acquisition is not grounded in real-world goals. Lessons will feel too abstract. You will have no way of judging what the user should do next.

Missions may change as the user develops more skills and knowledge. This is normal: make sure to update the `MISSION.md` and add a learning record to capture the change. Confirm with the user before changing the mission.

## Zone of proximal development

Each lesson, the user should always feel as if they are being challenged 'just enough'.

The user may specify an exact thing they want to learn. If they don't, figure out their zone of proximal development by:

- Reading their `learning-records`
- Figuring out the right thing to teach them based on their mission
- Teaching the most relevant thing that fits in their zone of proximal development

## Producing a lesson

A lesson is one self-contained HTML file in `./lessons/`, titled `0001-<dash-case-name>.html` with the number incrementing each time. It is the unit in which knowledge and skills reach the user, and everything else in the workspace exists to support it.

Read both of these before you write any HTML:

- [references/learning-science.md](references/learning-science.md) decides **what goes in the lesson**: the knowledge, skills, and wisdom the user needs, which of the three this lesson is buying, and how much difficulty that answer justifies.
- [references/lesson-craft.md](references/lesson-craft.md) decides **what the lesson looks like**: length, beauty, citations, the components in `./assets/` to build from, and the reference document the lesson compresses down to.

## `NOTES.md`

The user will sometimes express preferences of how they want to be taught, or things you should keep in mind. This is the place to record those preferences, so you can refer back to them when designing lessons or working with the user.
