"""Verification: offline diagnostics and the browser end-to-end harness.

These are evidence, not pipeline. `check_bleed` and `check_fringe` are what back
the 8px bleed and the fringe caveat in DESIGN.md; `test_weight_golden` pins the
Python and JS weight fields to each other; `test_persist` drives a real browser.
"""
