"""Cy, the CY Desk mascot: a white plush with real fur, rendered in Cycles.

Run with Blender:
  blender -b --factory-startup -P mascot/build_mascot.py -- test   <out.png> [yaw pitch]
  blender -b --factory-startup -P mascot/build_mascot.py -- batch  <out_dir>

The face (eyes, mouth, cheeks) is not rendered: the dashboard draws it on top, using
the anchors this script exports for every pose (anchors.json).
"""
import bpy, bmesh, math, sys, json, os
from mathutils import Vector, Euler, Matrix
from bpy_extras.object_utils import world_to_camera_view

YAWS = list(range(-30, 31, 3))
PITCHES = [-12, -8, -4, 0, 4, 8, 12]
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else ['test', 'test.png']
W, H = 448, 516
CREAM = (0.93, 0.90, 0.86, 1)
YELLOW = (0.85, 0.36, 0.012, 1)


# ---------------------------------------------------------------- scene
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'OPTIX'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'OPTIX'
    sc.cycles.device = 'GPU'
    sc.cycles.samples = int(os.environ.get('CY_SAMPLES', 64))
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = 'OPTIX'
    sc.cycles.max_bounces = 8
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = W, H
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = 'PNG'
    sc.render.image_settings.color_mode = 'RGBA'
    try:
        sc.view_settings.view_transform = 'AgX'
        sc.view_settings.look = 'AgX - Medium High Contrast'
    except Exception:
        pass
    try:
        sc.cycles_curves.shape = 'THICK'
    except Exception:
        pass
    world = bpy.data.worlds.new('W')
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.92, 0.89, 0.85, 1)
    bg.inputs['Strength'].default_value = 0.55
    return sc


def ellipsoid(name, loc, scale, seg=64, rings=32):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.object.shade_smooth()
    return o


# ---------------------------------------------------------------- materials
def mat_skin():
    m = bpy.data.materials.new('Skin')
    m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = CREAM
    p.inputs['Roughness'].default_value = 0.85
    for k, v in (('Sheen Weight', 0.6), ('Subsurface Weight', 0.15)):
        if k in p.inputs:
            p.inputs[k].default_value = v
    return m


def mat_fur():
    m = bpy.data.materials.new('Fur')
    m.use_nodes = True
    nt = m.node_tree
    out = nt.nodes['Material Output']
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    hair = nt.nodes.new('ShaderNodeBsdfHairPrincipled')
    for prop, val in (('model', 'CHIANG'), ('parametrization', 'MELANIN')):
        try:
            setattr(hair, prop, val)
        except Exception:
            pass
    vals = {'Melanin': 0.075, 'Melanin Redness': 0.7, 'Roughness': 0.42, 'Radial Roughness': 0.55,
            'Coat': 0.15, 'IOR': 1.55, 'Random Roughness': 0.3, 'Random Color': 0.1}
    for k, v in vals.items():
        if k in hair.inputs:
            hair.inputs[k].default_value = v
    if 'Tint' in hair.inputs:
        hair.inputs['Tint'].default_value = (1.0, 0.97, 0.93, 1)
    nt.links.new(hair.outputs[0], out.inputs['Surface'])
    return m


def mat_knit():
    m = bpy.data.materials.new('Knit')
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = YELLOW
    p.inputs['Roughness'].default_value = 0.9
    if 'Sheen Weight' in p.inputs:
        p.inputs['Sheen Weight'].default_value = 1.0
    wave = nt.nodes.new('ShaderNodeTexWave')
    wave.inputs['Scale'].default_value = 14
    wave.inputs['Distortion'].default_value = 2
    noise = nt.nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 60
    mix = nt.nodes.new('ShaderNodeMath')
    mix.operation = 'ADD'
    nt.links.new(wave.outputs['Fac'], mix.inputs[0])
    nt.links.new(noise.outputs['Fac'], mix.inputs[1])
    bump = nt.nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.6
    nt.links.new(mix.outputs[0], bump.inputs['Height'])
    nt.links.new(bump.outputs['Normal'], p.inputs['Normal'])
    return m


def mat_wool():
    m = bpy.data.materials.new('Wool')
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.remove(nt.nodes['Principled BSDF'])
    hair = nt.nodes.new('ShaderNodeBsdfHairPrincipled')
    try:
        hair.parametrization = 'COLOR'
    except Exception:
        pass
    for k, v in (('Roughness', 0.6), ('Radial Roughness', 0.7), ('Coat', 0.0)):
        if k in hair.inputs:
            hair.inputs[k].default_value = v
    if 'Color' in hair.inputs:
        hair.inputs['Color'].default_value = YELLOW
    nt.links.new(hair.outputs[0], nt.nodes['Material Output'].inputs['Surface'])
    return m


# ---------------------------------------------------------------- fur (geometry nodes)
def fur_group(density, length, mess, material, source=None, face=False, hair_mat=None):
    # Blender 5 modifiers don't take id-property inputs: one group per setting, values baked in.
    ng = bpy.data.node_groups.new('Fur', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    N, L = ng.nodes, ng.links
    gi, go = N.new('NodeGroupInput'), N.new('NodeGroupOutput')
    def const(v):
        n = N.new('ShaderNodeValue'); n.outputs[0].default_value = v; return n.outputs[0]
    params = {'Density': const(density), 'Length': const(length), 'Mess': const(mess)}

    info = N.new('GeometryNodeObjectInfo')
    info.transform_space = 'RELATIVE'
    info.inputs['Object'].default_value = source
    dist = N.new('GeometryNodeDistributePointsOnFaces')
    L.new(info.outputs['Geometry'], dist.inputs['Mesh'])
    L.new(params['Density'], dist.inputs['Density'])

    line = N.new('GeometryNodeCurvePrimitiveLine')
    line.inputs['End'].default_value = (0, 0, 1)
    res = N.new('GeometryNodeResampleCurve')
    res.inputs['Count'].default_value = 5
    L.new(line.outputs['Curve'], res.inputs['Curve'])

    rnd = N.new('FunctionNodeRandomValue')
    rnd.data_type = 'FLOAT'
    fsock = lambda socks, name: next(s for s in socks if s.name == name and s.type == 'VALUE')
    fsock(rnd.inputs, 'Min').default_value = 0.55
    fsock(rnd.inputs, 'Max').default_value = 1.15
    scl = N.new('ShaderNodeMath'); scl.operation = 'MULTIPLY'
    L.new(fsock(rnd.outputs, 'Value'), scl.inputs[0])
    L.new(params['Length'], scl.inputs[1])

    if face:
        # front-ness of each root: dot(normal, -Y) mapped to 0..1, length x (1 - 0.65 f)
        dot = N.new('ShaderNodeVectorMath'); dot.operation = 'DOT_PRODUCT'
        L.new(dist.outputs['Normal'], dot.inputs[0]); dot.inputs[1].default_value = (0, -1, 0)
        fm = N.new('ShaderNodeMapRange'); fm.clamp = True
        L.new(dot.outputs['Value'], fm.inputs['Value'])
        fm.inputs['From Min'].default_value = 0.72; fm.inputs['From Max'].default_value = 0.93
        fm.inputs['To Min'].default_value = 1.0; fm.inputs['To Max'].default_value = 0.35
        fmul = N.new('ShaderNodeMath'); fmul.operation = 'MULTIPLY'
        L.new(scl.outputs[0], fmul.inputs[0]); L.new(fm.outputs['Result'], fmul.inputs[1])
        scale_out = fmul.outputs[0]
    else:
        scale_out = scl.outputs[0]
    inst = N.new('GeometryNodeInstanceOnPoints')
    L.new(dist.outputs['Points'], inst.inputs['Points'])
    L.new(res.outputs['Curve'], inst.inputs['Instance'])
    L.new(dist.outputs['Rotation'], inst.inputs['Rotation'])
    L.new(scale_out, inst.inputs['Scale'])
    real = N.new('GeometryNodeRealizeInstances')
    L.new(inst.outputs['Instances'], real.inputs['Geometry'])

    # Messy tips: noise offset that grows from root to tip, plus a little gravity.
    par = N.new('GeometryNodeSplineParameter')
    noise = N.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 7
    noise.inputs['Detail'].default_value = 3
    sub = N.new('ShaderNodeVectorMath'); sub.operation = 'SUBTRACT'
    L.new(noise.outputs['Color'], sub.inputs[0])
    sub.inputs[1].default_value = (0.5, 0.5, 0.62)
    pw = N.new('ShaderNodeMath'); pw.operation = 'POWER'
    L.new(par.outputs['Factor'], pw.inputs[0]); pw.inputs[1].default_value = 1.6
    amt = N.new('ShaderNodeMath'); amt.operation = 'MULTIPLY'
    L.new(pw.outputs[0], amt.inputs[0]); L.new(params['Mess'], amt.inputs[1])
    off = N.new('ShaderNodeVectorMath'); off.operation = 'SCALE'
    L.new(sub.outputs[0], off.inputs[0]); L.new(amt.outputs[0], off.inputs['Scale'])
    setp = N.new('GeometryNodeSetPosition')
    L.new(real.outputs['Geometry'], setp.inputs['Geometry'])
    L.new(off.outputs[0], setp.inputs['Offset'])

    mr = N.new('ShaderNodeMapRange')
    L.new(par.outputs['Factor'], mr.inputs['Value'])
    mr.inputs['To Min'].default_value = 0.0055
    mr.inputs['To Max'].default_value = 0.0012
    rad = N.new('GeometryNodeSetCurveRadius')
    L.new(setp.outputs['Geometry'], rad.inputs['Curve'])
    L.new(mr.outputs['Result'], rad.inputs['Radius'])
    sm = N.new('GeometryNodeSetMaterial')
    L.new(rad.outputs['Curve'], sm.inputs['Geometry'])
    sm.inputs['Material'].default_value = material

    L.new(sm.outputs['Geometry'], go.inputs['Geometry'])
    return ng


def add_fur(obj, ng, fur, density=3000, length=0.09, mess=0.05, face=False):
    # Cycles renders hair only from a Curves object: one per furry part, fed by the mesh.
    data = bpy.data.hair_curves.new(f'{obj.name}Fur')
    data.materials.append(fur)
    co = bpy.data.objects.new(f'{obj.name}Fur', data)
    bpy.context.scene.collection.objects.link(co)
    mod = co.modifiers.new('Fur', 'NODES')
    mod.node_group = fur_group(density, length, mess, fur, obj, face=face)


# ---------------------------------------------------------------- character
def build():
    sc = reset()
    skin, fur, knit = mat_skin(), mat_fur(), mat_knit()
    ng = None

    rig = bpy.data.objects.new('Rig', None); sc.collection.objects.link(rig)
    body_piv = bpy.data.objects.new('BodyPivot', None); sc.collection.objects.link(body_piv)
    body_piv.parent = rig; body_piv.location = (0, 0, -1.9)
    head_piv = bpy.data.objects.new('HeadPivot', None); sc.collection.objects.link(head_piv)
    head_piv.parent = body_piv; head_piv.location = (0, 0, 1.0)  # neck at z=-0.9

    head = ellipsoid('Head', (0, 0, 0), (1.08, 0.96, 0.92))
    head.data.materials.append(skin)
    head.parent = head_piv; head.location = (0, 0, 0.9)
    add_fur(head, ng, fur, density=2800, length=0.085, mess=0.045, face=True)

    tuft = ellipsoid('Tuft', (0, 0, 0), (0.16, 0.12, 0.12), 32, 16)
    tuft.data.materials.append(skin)
    tuft.parent = head; tuft.location = (-0.08, -0.05, 0.86); tuft.rotation_euler = (0, math.radians(-20), 0)
    add_fur(tuft, ng, fur, density=3000, length=0.26, mess=0.14)

    body = ellipsoid('Body', (0, 0, 0), (0.74, 0.66, 0.68))
    body.data.materials.append(skin)
    body.parent = body_piv; body.location = (0, 0, 0.62)
    add_fur(body, ng, fur, density=2600, length=0.08, mess=0.045)

    scarf_op = bpy.ops.mesh.primitive_torus_add(major_radius=0.6, minor_radius=0.15, major_segments=96, minor_segments=32)
    scarf = bpy.context.active_object; scarf.name = 'Scarf'
    bpy.ops.object.shade_smooth()
    scarf.data.materials.append(knit)
    scarf.parent = body_piv; scarf.location = (0, -0.02, 1.06); scarf.scale = (1.05, 0.95, 1.0)
    scarf.rotation_euler = (math.radians(8), 0, 0)
    add_fur(scarf, ng, mat_wool(), density=5000, length=0.028, mess=0.02)

    arms = {}
    for side, sx in (('L', 1), ('R', -1)):
        piv = bpy.data.objects.new(f'ArmPivot{side}', None); sc.collection.objects.link(piv)
        piv.parent = body_piv; piv.location = (0.62 * sx, -0.04, 0.86)
        arm = ellipsoid(f'Arm{side}', (0, 0, 0), (0.17, 0.16, 0.34), 48, 24)
        arm.data.materials.append(skin)
        arm.parent = piv; arm.location = (0.1 * sx, 0, -0.24)
        add_fur(arm, ng, fur, density=2600, length=0.07, mess=0.04)
        piv.rotation_euler = (0, math.radians(-28 * sx), 0)
        arms[side] = piv
    feet = {}
    for side, sx in (('L', 1), ('R', -1)):
        foot = ellipsoid(f'Foot{side}', (0, 0, 0), (0.22, 0.27, 0.15), 48, 24)
        foot.data.materials.append(skin)
        foot.parent = body_piv; foot.location = (0.3 * sx, -0.1, 0.03)
        add_fur(foot, ng, fur, density=2600, length=0.06, mess=0.035)
        feet[side] = foot
    character = [o for o in sc.objects if o.type in ('MESH', 'CURVES')]
    mic = build_mic(sc)

    # Face anchors: points on the head surface the dashboard draws the face at.
    def surf(x, z):
        d = Vector((x, -1.0, z)).normalized()
        # ray from the centre to the scaled ellipsoid surface
        s = Vector((1.08, 0.96, 0.92))
        t = 1.0 / math.sqrt((d.x / s.x) ** 2 + (d.y / s.y) ** 2 + (d.z / s.z) ** 2)
        return d * (t + 0.03)
    anchors = {}
    for name, (x, z) in {'eyeL': (0.3, 0.04), 'eyeR': (-0.3, 0.04), 'mouth': (0.0, -0.2),
                          'cheekL': (0.52, -0.16), 'cheekR': (-0.52, -0.16), 'browL': (0.3, 0.27), 'browR': (-0.3, 0.27)}.items():
        e = bpy.data.objects.new(f'A_{name}', None); sc.collection.objects.link(e)
        e.parent = head; e.location = surf(x, z)
        anchors[name] = e

    # Lights: warm key, cool fill, strong rim to make the fur glow.
    def light(name, loc, power, size, color):
        ld = bpy.data.lights.new(name, 'AREA'); ld.energy = power; ld.size = size; ld.color = color
        lo = bpy.data.objects.new(name, ld); sc.collection.objects.link(lo); lo.location = loc
        c = lo.constraints.new('TRACK_TO'); c.target = rig; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
        return lo
    light('Key', (-4.5, -6.5, 5.0), 1800, 4, (1.0, 0.95, 0.88))
    light('Fill', (6.0, -5.0, 0.5), 260, 7, (0.9, 0.95, 1.0))
    light('Rim', (2.5, 5.5, 4.5), 1600, 3, (1.0, 0.96, 0.9))
    light('RimL', (-3.5, 4.5, 1.0), 700, 3, (1.0, 0.97, 0.93))

    cam_d = bpy.data.cameras.new('Cam'); cam_d.lens = 100
    cam = bpy.data.objects.new('Cam', cam_d); sc.collection.objects.link(cam)
    cam.location = (0, -12.5, 0.15)
    tgt = bpy.data.objects.new('CamTarget', None); sc.collection.objects.link(tgt); tgt.location = (0, 0, -0.45)
    c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis = 'TRACK_NEGATIVE_Z'; c.up_axis = 'UP_Y'
    sc.camera = cam
    return sc, {'rig': rig, 'body': body_piv, 'head': head_piv, 'arms': arms, 'feet': feet, 'anchors': anchors, 'cam': cam,
                'character': character, 'mic': mic}


def build_mic(sc):
    """A stand microphone in front of Cy, rendered on its own layer (shown while Cy sings)."""
    def mat(name, color, metal, rough, bump=False):
        m = bpy.data.materials.new(name); m.use_nodes = True
        p = m.node_tree.nodes['Principled BSDF']
        p.inputs['Base Color'].default_value = color
        p.inputs['Metallic'].default_value = metal
        p.inputs['Roughness'].default_value = rough
        if bump:
            nt = m.node_tree
            w = nt.nodes.new('ShaderNodeTexWave'); w.inputs['Scale'].default_value = 38
            w2 = nt.nodes.new('ShaderNodeTexWave'); w2.inputs['Scale'].default_value = 38; w2.bands_direction = 'Y'
            mx = nt.nodes.new('ShaderNodeMath'); mx.operation = 'MULTIPLY'
            nt.links.new(w.outputs['Fac'], mx.inputs[0]); nt.links.new(w2.outputs['Fac'], mx.inputs[1])
            b = nt.nodes.new('ShaderNodeBump'); b.inputs['Strength'].default_value = 0.8
            nt.links.new(mx.outputs[0], b.inputs['Height']); nt.links.new(b.outputs['Normal'], p.inputs['Normal'])
        return m
    chrome = mat('Grille', (0.82, 0.82, 0.84, 1), 1.0, 0.28, bump=True)
    black = mat('Handle', (0.018, 0.018, 0.02, 1), 0.2, 0.35)
    steel = mat('Pole', (0.12, 0.12, 0.13, 1), 1.0, 0.35)
    parts = []
    head = ellipsoid('MicHead', (0, -1.55, -0.46), (0.18, 0.18, 0.22), 48, 24)
    head.rotation_euler = (math.radians(-22), 0, 0); head.data.materials.append(chrome); parts.append(head)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.078, depth=0.46, location=(0, -1.62, -0.8), rotation=(math.radians(-22), 0, 0))
    h = bpy.context.active_object; bpy.ops.object.shade_smooth(); h.data.materials.append(black); parts.append(h)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.028, depth=1.06, location=(0, -1.67, -1.5))
    pole = bpy.context.active_object; bpy.ops.object.shade_smooth(); pole.data.materials.append(steel); parts.append(pole)
    bpy.ops.mesh.primitive_cylinder_add(radius=0.38, depth=0.05, location=(0, -1.66, -2.03))
    base = bpy.context.active_object; bpy.ops.object.shade_smooth(); base.data.materials.append(black); parts.append(base)
    for o in parts:
        o.hide_render = True
    return parts


def pose(parts, yaw=0.0, pitch=0.0, roll=0.0, armL=28.0, armR=28.0, armLfwd=0.0, armRfwd=0.0, turn=0.0, sit=False, mic=False):
    """yaw > 0 turns the face to the image right, pitch > 0 looks down. Head takes the turn, the body a part of it.
    turn spins the whole body (turn-around frames); sit lowers the body with the legs out front; mic renders the
    microphone alone."""
    parts['head'].rotation_euler = Euler((math.radians(pitch), math.radians(roll), math.radians(yaw * 0.7)), 'XYZ')
    parts['body'].rotation_euler = Euler((0, 0, math.radians(yaw * 0.3)), 'XYZ')
    parts['rig'].rotation_euler = Euler((0, 0, math.radians(turn)), 'XYZ')
    parts['body'].location = (0, 0, -2.0 if sit else -1.9)
    for side, sx in (('L', 1), ('R', -1)):
        f = parts['feet'][side]
        f.location = (0.33 * sx, -0.6, 0.12) if sit else (0.3 * sx, -0.1, 0.03)
        f.rotation_euler = (math.radians(-62), 0, math.radians(-12 * sx)) if sit else (0, 0, 0)
    for o in parts['character']:
        o.hide_render = mic
    for o in parts['mic']:
        o.hide_render = not mic
    parts['arms']['L'].rotation_euler = Euler((math.radians(armLfwd), math.radians(-armL), 0), 'XYZ')
    parts['arms']['R'].rotation_euler = Euler((math.radians(armRfwd), math.radians(armR), 0), 'XYZ')


def anchors2d(sc, parts):
    """Each face anchor as screen x/y (0..1, y down) plus its local x/y axes for an affine transform."""
    bpy.context.view_layer.update()
    cam = parts['cam']
    out = {}
    for name, e in parts['anchors'].items():
        mw = e.matrix_world
        p = mw.translation
        # local tangent axes on the head surface: head x (sideways) and head z (up)
        hx = parts['anchors'][name].parent.matrix_world.to_3x3() @ Vector((1, 0, 0))
        hz = parts['anchors'][name].parent.matrix_world.to_3x3() @ Vector((0, 0, 1))
        k = 0.1
        def v(q):
            c = world_to_camera_view(sc, cam, q)
            return (c.x, 1 - c.y, c.z)
        p0, px, pz = v(p), v(p - hx.normalized() * k), v(p + hz.normalized() * k)
        # facing: normal vs camera direction (1 = facing, 0 = edge-on)
        n = (p - parts['anchors'][name].parent.matrix_world.translation).normalized()
        view = (cam.matrix_world.translation - p).normalized()
        out[name] = {
            'x': round(p0[0], 5), 'y': round(p0[1], 5),
            'ax': [round((px[0] - p0[0]) / k, 5), round((px[1] - p0[1]) / k, 5)],
            'az': [round((pz[0] - p0[0]) / k, 5), round((pz[1] - p0[1]) / k, 5)],
            'facing': round(max(0.0, n.dot(view)), 4)
        }
    return out


def render(sc, path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------- main
if __name__ == '__main__':
    mode = ARGS[0]
    sc, parts = build()
    if mode == 'test':
        pose(parts, **(json.loads(ARGS[2]) if len(ARGS) > 2 else {}))
        render(sc, ARGS[1])
        print('ANCHORS', json.dumps(anchors2d(sc, parts)))
    elif mode == 'batch':
        out_dir = ARGS[1]
        os.makedirs(out_dir, exist_ok=True)
        frames = {}
        jobs = []
        for pi, pitch in enumerate(PITCHES):
            for yi, yaw in enumerate(YAWS):
                jobs.append((f'g_{yi}_{pi}', dict(yaw=yaw, pitch=pitch)))
        for i in range(16):
            jobs.append((f'turn_{i:02d}', dict(turn=i * 22.5)))
        for i, yaw in enumerate((-18, -9, 0, 9, 18)):
            jobs.append((f'sit_{i}', dict(sit=True, yaw=yaw, armLfwd=-25, armRfwd=-25, armL=20, armR=20)))
        jobs += [
            ('wave_0', dict(armL=118, armLfwd=-28, yaw=-6)), ('wave_1', dict(armL=96, armLfwd=-28, yaw=-6)),
            ('cheer', dict(armL=108, armR=108, armLfwd=-22, armRfwd=-22, pitch=-6)),
            ('sleep', dict(pitch=9, roll=-9, armL=18, armR=18)),
            ('shrug', dict(armL=58, armR=58, armLfwd=-40, armRfwd=-40, pitch=4)),
            ('sit_sleep', dict(sit=True, pitch=10, roll=-10, armLfwd=-25, armRfwd=-25, armL=18, armR=18)),
            ('sing_0', dict(armL=62, armR=62, armLfwd=-48, armRfwd=-48, pitch=-4)),
            ('sing_1', dict(armL=92, armR=48, armLfwd=-30, armRfwd=-50, pitch=-6)),
            ('mic', dict(mic=True)),
        ]
        only = set(ARGS[2].split(',')) if len(ARGS) > 2 else None
        for name, kw in jobs:
            if only and name not in only:
                continue
            pose(parts, **kw)
            render(sc, os.path.join(out_dir, f'{name}.png'))
            frames[name] = anchors2d(sc, parts)
            print('DONE', name, flush=True)
        prev = {}
        ap = os.path.join(out_dir, 'anchors.json')
        if only and os.path.exists(ap):
            prev = json.load(open(ap))
        prev.update(frames)
        prev.update({'width': W, 'height': H, 'yaws': YAWS, 'pitches': PITCHES})
        json.dump(prev, open(ap, 'w'), indent=1)
