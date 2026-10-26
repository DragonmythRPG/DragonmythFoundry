# Foundry repository

This directory is the standalone Foundry VTT module repository:
`DragonmythRPG/DragonmythFoundry`. It is not the root of a whole-project
monorepo. The sibling `Website/` and `Discord/` directories are independent
repositories; do not stage or push their files from here.

The parent Dragonmyth Project directory is a local integration workspace, not
a GitHub repository. Keep module source and commits in this repository. The
Foundry module folder installed in Foundry must be named
`dragonmyth-sync`, matching `module.json`.
