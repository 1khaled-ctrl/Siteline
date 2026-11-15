"""Turn jgilhutton's rigged EMU suit (Blend Swap 73994, CC BY 3.0) into a small skinned glTF for the web.

Run: blender -b Astronauta.blend --python export_astronaut.py -- astronaut.glb
"""

import sys

import bpy

OUT = sys.argv[sys.argv.index("--") + 1]
arm = bpy.data.objects["metarig"]

# 1. Keep only what is drawn on the astronaut: meshes with faces, hanging off the rig. The rest are bone widgets,
#    the backdrop sphere, the camera and the lamp.
keep = set()
for o in bpy.data.objects:
    if o.type != "MESH" or len(o.data.polygons) == 0:
        continue
    p = o
    while p.parent:
        p = p.parent
    if p == arm:
        keep.add(o.name)
for o in list(bpy.data.objects):
    if o != arm and o.name not in keep:
        bpy.data.objects.remove(o, do_unlink=True)

# 2. Rest pose, no constraints: the web drives the deforming bones directly.
arm.data.pose_position = "REST"
for pb in arm.pose.bones:
    for c in list(pb.constraints):
        pb.constraints.remove(c)
    pb.location = (0, 0, 0)
    pb.rotation_quaternion = (1, 0, 0, 0)
    pb.rotation_euler = (0, 0, 0)
    pb.scale = (1, 1, 1)

# 3. The shoulder patches follow the IK arm bones and the notepad hangs off one; move them onto the arm bones kept.
for name, side in (("Plane.004", "L"), ("Plane.006", "R")):
    vg = bpy.data.objects[name].vertex_groups.get(f"upper_arm.IK.{side}")
    if vg:
        vg.name = f"upper_arm.{side}"
note = bpy.data.objects.get("Notepad")
if note:
    m = note.matrix_world.copy()
    note.parent_bone = "forearm.L"
    note.matrix_world = m

# 4. Apply the detail modifiers at a light level (the suit's multires at 1, subdivision at 1), keeping the skin.
bpy.context.view_layer.update()
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    bpy.context.view_layer.objects.active = o
    for mod in list(o.modifiers):
        if mod.type == "ARMATURE":
            continue
        if mod.type == "MULTIRES":
            mod.levels = 1
        if mod.type == "SUBSURF":
            mod.levels = min(mod.levels, 1)
            if mod.levels == 0:
                o.modifiers.remove(mod)
                continue
        with bpy.context.temp_override(object=o, active_object=o):
            bpy.ops.object.modifier_apply(modifier=mod.name)

# 5. Drop the control bones (IK, FK, poles); keep the deforming chain.
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones
for b in list(eb):
    n = b.name
    if ".IK." in n or ".FK." in n or n.startswith("Polo."):
        eb.remove(b)
bpy.ops.object.mode_set(mode="OBJECT")
arm.data.pose_position = "POSE"


# 6. The materials are old Cycles mixes the glTF exporter cannot read: rebuild each as a Principled BSDF with its
#    colour and normal images, and its look (fabric, metal, glass).
def images(mat):
    colour = normal = None
    for n in mat.node_tree.nodes if mat.node_tree else []:
        if n.type == "TEX_IMAGE" and n.image:
            if "ormal" in n.image.name or "_NRM" in n.image.name:
                normal = normal or n.image
            else:
                colour = colour or n.image
    return colour, normal


GLASS = {"Material.007", "TRANSPARENTE", "Vidrio Dorado"}
METAL = {"metal", "Metal rojo", "ANISOTROPICO GRIS", "ANISOTROPICO GRIS PERILLAS", "Material.005"}
EMIT = {"Display", "GAUGE", "Luz"}
for mat in bpy.data.materials:
    if mat.users == 0:
        continue
    colour, normal = images(mat)
    base = tuple(mat.diffuse_color)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = base
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Metallic"].default_value = 0.0
    if mat.name in METAL:
        bsdf.inputs["Metallic"].default_value = 0.8
        bsdf.inputs["Roughness"].default_value = 0.4
    if mat.name in GLASS:
        bsdf.inputs["Alpha"].default_value = 0.35
        bsdf.inputs["Roughness"].default_value = 0.1
        mat.surface_render_method = "BLENDED"
    if colour:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = colour
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if colour.name.endswith(".png") or ".png" in colour.name:
            nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
            mat.surface_render_method = "BLENDED"
        if mat.name in EMIT:
            nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
            bsdf.inputs["Emission Strength"].default_value = 1.0
    if normal:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = normal
        tex.image.colorspace_settings.name = "Non-Color"
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tex.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

# 7. Smaller images: the suit's 4096 maps to 2048 (colour) and 1024 (normal), the chest pack at 1024, the rest at most
#    512 (the helmet is hidden in first person) and the small patches and notepad at 256.
for img in bpy.data.images:
    if img.users == 0 or img.size[0] == 0:
        continue
    n = img.name
    cap = 2048 if n.startswith("Traje") else 1024 if n.startswith(("Normal para traje", "Modulo de comando")) else 512
    if n.startswith(("vitruvio", "pin_page", "unflag")):
        cap = 256
    w, h = img.size
    k = min(1.0, cap / max(w, h))
    if k < 1.0:
        img.scale(max(1, int(w * k)), max(1, int(h * k)))

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_image_format="AUTO",
    export_jpeg_quality=82,
    export_skins=True,
    export_def_bones=False,
    export_animations=False,
    export_rest_position_armature=True,
    export_apply=False,
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
print("WROTE", OUT)
