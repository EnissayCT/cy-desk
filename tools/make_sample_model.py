"""A tiny sample companion for the "your own 3D model" setting and its test: a round robot with
Idle, Wave and Dance clips, exported as .glb.
Usage: blender -b --factory-startup -P tools/make_sample_model.py -- docs/sample-robot.glb"""
import bpy, math, sys

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'sample-robot.glb'
bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.fps = 24


def mat(name, rgb, rough=0.45, metal=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


shell, dark, glow = mat('Shell', (0.93, 0.9, 0.86)), mat('Visor', (0.06, 0.06, 0.08), 0.2), mat('Glow', (1.0, 0.62, 0.12), 0.3)


def sphere(name, loc, scale, m, parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, location=loc)
    o = bpy.context.object
    o.name = name; o.scale = scale; o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    if parent: o.parent = parent
    return o


root = bpy.data.objects.new('Robot', None); sc.collection.objects.link(root)
body = sphere('Body', (0, 0, 0.42), (0.36, 0.32, 0.4), shell, root)
head = bpy.data.objects.new('HeadPivot', None); sc.collection.objects.link(head); head.parent = root; head.location = (0, 0, 0.82)
sphere('Head', (0, 0, 0.2), (0.34, 0.31, 0.27), shell, head)
sphere('Visor', (0, -0.17, 0.2), (0.25, 0.16, 0.15), dark, head)
for x in (-0.09, 0.09):
    sphere('Eye', (x, -0.3, 0.22), (0.045, 0.02, 0.055), glow, head)
sphere('Antenna', (0, 0, 0.52), (0.05, 0.05, 0.05), glow, head)
arms = {}
for side, x in (('L', 0.38), ('R', -0.38)):
    piv = bpy.data.objects.new(f'Arm{side}', None); sc.collection.objects.link(piv); piv.parent = root; piv.location = (x, 0, 0.6)
    sphere(f'Hand{side}', (0.04 if x > 0 else -0.04, 0, -0.16), (0.09, 0.09, 0.17), shell, piv)
    arms[side] = piv
for x in (-0.15, 0.15):
    sphere('Foot', (x, -0.04, 0.05), (0.12, 0.15, 0.07), shell, root)


def key(obj, path, frame, value):
    setattr(obj, path, value)
    obj.keyframe_insert(data_path=path, frame=frame)


def action(name, frames, fn):
    for o in (root, head, arms['L'], arms['R']):
        o.animation_data_create()
        o.animation_data.action = bpy.data.actions.new(f'{name}_{o.name}')
    fn()
    # Push each object's action into an NLA track named after the clip: the exporter merges tracks by name.
    for o in (root, head, arms['L'], arms['R']):
        a = o.animation_data.action
        t = o.animation_data.nla_tracks.new(); t.name = name
        t.strips.new(name, 1, a)
        o.animation_data.action = None
        o.rotation_euler = (0, 0, 0); o.location = o.location


def idle():
    for f, z in ((1, 0.82), (24, 0.85), (48, 0.82)):
        key(head, 'location', f, (0, 0, z))
    for f, r in ((1, 0), (24, 4), (48, 0)):
        key(head, 'rotation_euler', f, (0, math.radians(r), 0))
    for side in 'LR':
        key(arms[side], 'rotation_euler', 1, (0, 0, 0)); key(arms[side], 'rotation_euler', 48, (0, 0, 0))
    key(root, 'rotation_euler', 1, (0, 0, 0)); key(root, 'rotation_euler', 48, (0, 0, 0))


def wave():
    for f, a in ((1, 0), (8, 150), (16, 120), (24, 150), (32, 120), (40, 150), (48, 0)):
        key(arms['L'], 'rotation_euler', f, (0, math.radians(-a), 0))
    key(arms['R'], 'rotation_euler', 1, (0, 0, 0)); key(arms['R'], 'rotation_euler', 48, (0, 0, 0))
    for f, r in ((1, 0), (24, -8), (48, 0)):
        key(head, 'rotation_euler', f, (0, math.radians(r), 0))
    key(head, 'location', 1, (0, 0, 0.82)); key(head, 'location', 48, (0, 0, 0.82))
    key(root, 'rotation_euler', 1, (0, 0, 0)); key(root, 'rotation_euler', 48, (0, 0, 0))


def dance():
    for i, f in enumerate(range(1, 50, 6)):
        s = 1 if i % 2 else -1
        key(root, 'rotation_euler', f, (0, math.radians(8 * s), math.radians(14 * s)))
        key(arms['L'], 'rotation_euler', f, (0, math.radians(-120 if s > 0 else -40), 0))
        key(arms['R'], 'rotation_euler', f, (0, math.radians(40 if s > 0 else 120), 0))
        key(head, 'location', f, (0, 0, 0.82 + (0.04 if i % 2 else 0)))
        key(head, 'rotation_euler', f, (0, math.radians(-10 * s), 0))


action('Idle', 48, idle)
action('Wave', 48, wave)
action('Dance', 48, dance)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=True, export_animation_mode='NLA_TRACKS', export_apply=False)
print('WROTE', out)
