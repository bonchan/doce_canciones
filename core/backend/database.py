import os
from tinydb import TinyDB, Query
from dotenv import load_dotenv

# Load env variables
load_dotenv()

CLEAR_DB_ON_STARTUP = os.getenv("CLEAR_DB_ON_STARTUP", False)

# Ensure the data directory exists locally
os.makedirs("data", exist_ok=True)
db = TinyDB("data/db.json")
devices_table = db.table("devices")
Device = Query()

if CLEAR_DB_ON_STARTUP:
    devices_table.truncate()
    print("🧹 Clear DB Flag active: TinyDB table has been truncated.")

def get_or_create_device(chip_id):
    device = devices_table.get(Device.id == chip_id)
    if not device:
        device = {
            "id": chip_id,
            "name": None, 
            "configured": False,
            "position": {"x": 0.5, "y": 0.5, "z": 0.0},
            "last_seen_telemetry": None
        }
        devices_table.insert(device)
    return device

def update_device_telemetry(chip_id, telemetry_data):
    devices_table.update({"last_seen_telemetry": telemetry_data}, Device.id == chip_id)

def update_device_config(chip_id, name, x, y, z):
    devices_table.update({
        "name": name,
        "position": {"x": x, "y": y, "z": z},
        "configured": True
    }, Device.id == chip_id)

def get_all_devices():
    return devices_table.all()