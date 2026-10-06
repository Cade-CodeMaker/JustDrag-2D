"""Shared, renderer-agnostic groundwork: project layout, matting, weight field,
deformation math.

The deformation is defined twice on purpose, once per language:

    core/deform.glsl        the shader that actually runs
    core/deform.py          a Python port, used as an oracle for offline preview

    core/region_field.js    the weight field the browser rasterises
    core/region_field.py    a Python port of the same field

Nothing generates one from the other; `verify/test_weight_golden.*` pins them
together numerically instead, so a drift in either shows up as a failing test
rather than as a subtly wrong picture.
"""
