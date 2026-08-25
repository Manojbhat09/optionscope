# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec — freezes the Flask backend into a single executable that
# the Electron desktop shell spawns as a sidecar (files/desktop-app-design.md).
#
# Build:  cd backend && pyinstaller optionscope_backend.spec --noconfirm
# Result: dist/optionscope-backend(.exe)   run with:
#   PORT=57631 OPTIONSCOPE_BUILD_DIR=<path to build/> ./optionscope-backend

import os

block_cipher = None
HERE = os.path.abspath(os.path.dirname(SPEC))

hiddenimports = [
    # heavy optional deps the agent pipeline imports lazily
    'statsmodels', 'statsmodels.tsa.arima.model',
    'sklearn', 'sklearn.ensemble',
    'yfinance', 'robin_stocks', 'robin_stocks.robinhood',
    'engineio.async_drivers',  # silence common false positive
]

a = Analysis(
    ['app.py'],
    pathex=[HERE],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=['tkinter', 'matplotlib', 'torch', 'torchvision', 'IPython', 'jupyter',],
    cipher=block_cipher,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name='optionscope-backend',
    console=True,          # logs are useful when debugging the sidecar
    disable_windowed_traceback=False,
)
