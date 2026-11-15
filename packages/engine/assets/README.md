# Engine assets

`astronaut.glb` is the astronaut you walk as in Land Here: "Astronaut - EMU suit - Rigged" by jgilhutton
([Blend Swap 73994](http://www.blendswap.com/blends/view/73994)), used under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). It is credited in `CREDITS.md` (`jgilhutton-emu-suit`)
and in Land Here's About panel.

To rebuild it, download `Astronauta.blend` from Blend Swap and run (Blender 5.3):

```bash
blender -b Astronauta.blend --python export_astronaut.py -- astronaut.glb
```

The script keeps the suit's deforming skeleton (the bones `astronaut.ts` turns), applies the detail modifiers at level
1, rebuilds the materials as glTF PBR from the model's own images and scales the images down, so the file stays near
3 MB.
