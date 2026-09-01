import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from llm_client import _load_env_key
key = _load_env_key()
print(f"Key found: {key[:25] if key else 'NONE'}...")
print(f"Key length: {len(key)}")
