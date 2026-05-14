# Little Bugger 🐛

A small bridge between Claude managers in your browser and Claude Code workers on your machine.

## What it does

You run multiple Claude.ai conversations as managers — one per project. Each conversation is bound to a repo on your machine via a Chrome extension. When a manager dispatches work, the daemon pipes it to Claude Code running in the right repo. Results flow back into the chat automatically.

You stop being the message bus. The terminals stay minimized. You work in browser tabs that look like paper, not consoles.

## Status

Greenfield. Spec is at [`SPEC.md`](SPEC.md). The manager skill that teaches a Claude.ai conversation how to use it is at [`skill/manager-skill.md`](skill/manager-skill.md).

## How to use it (when built)

1. Install the daemon on your machine (Windows MSI or macOS PKG)
2. Install the Chrome extension
3. Edit `~/.bugger/config.json` to map project names to local repo paths
4. Load the manager skill into your Claude.ai Projects
5. Open a Claude.ai conversation for a project, click the 🐛 icon, bind the tab
6. Talk to the manager. When it dispatches, the worker runs locally and the result comes back automatically.

## Principles

- One person uses this. Single user. No accounts. No cloud.
- The repo is the source of truth. Pull at start of day, push at end.
- Browser tab binding determines routing. Managers can't misroute even if they try.
- The daemon is a courier, not a brain. Managers think. Workers execute. Little Bugger ferries messages.
- Local-first. Nothing leaves your machine except Claude Code's normal API calls.

## Built from lessons learned

This project follows a smaller cousin's worth of architecture. The bigger sibling — [The Big Brain](https://github.com/mrmicaiah/the-big-brain) — was an attempt to build the same workflow as a full web app with managers, durable objects, and deployed infrastructure. Little Bugger is what's left when you strip that down to the part that genuinely matters: the bridge.
