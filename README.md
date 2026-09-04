# Browser Video Editor Prototype

Multi-track browser video editor (fork of [OpenReel Video](https://github.com/Augani/openreel-video))
with a library of programmatic animated components rendered by
[Motion Canvas](https://github.com/motion-canvas/motion-canvas).

All open source, all self-hosted. No cloud APIs, no paid SaaS.

## Layout

```
apps/editor           fork of OpenReel Video + "Component Library" panel
apps/render-service    Node.js service: componentId + props -> rendered webm
packages/component-library  Motion Canvas scene-components + meta.json schemas
infra/                 docker-compose (Redis)
storage/rendered/      rendered output files
```

## Running

_to be filled in as stages land_
