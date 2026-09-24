#!/usr/bin/env python3
"""Compatibility entry point for the measured Caliper latency plotter."""

from __future__ import annotations

from pathlib import Path
import runpy


SCRIPT = (
  Path(__file__).resolve().parents[2]
  / "benchmarks"
  / "caliper"
  / "scripts"
  / "generate-latency-result-graphs.py"
)

runpy.run_path(str(SCRIPT), run_name="__main__")
