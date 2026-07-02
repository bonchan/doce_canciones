import os
from tinydb import TinyDB, Query
from dotenv import load_dotenv

load_dotenv()

CLEAR_DB_ON_STARTUP = os.getenv("CLEAR_DB_ON_STARTUP", "False") == "True"

os.makedirs("data", exist_ok=True)
db = TinyDB("data/db.json")
devices_table = db.table("devices")
Device = Query()

if CLEAR_DB_ON_STARTUP:
    devices_table.truncate()
    print("DB cleared on startup.")

def get_or_create_device(chip_id, fw_version, script_name):
    device = devices_table.get(Device.id == chip_id)
    if not device:
        device = {
            "id": chip_id,
            "fw": fw_version,
            "sn": script_name,
            "name": None,
            "configured": False,
            "position": {"x": 0.5, "y": 0.5, "z": 0.0}
        }
        devices_table.insert(device)
    else:
        devices_table.update({"fw": fw_version, "sn": script_name}, Device.id == chip_id)
        device["fw"] = fw_version
        device["sn"] = script_name
    return device

def update_device_config(chip_id, name, x, y, z):
    devices_table.update({
        "name": name,
        "position": {"x": x, "y": y, "z": z},
        "configured": True
    }, Device.id == chip_id)

def get_all_devices():
    return devices_table.all()

def get_config_payload():
    """Returns list of configured devices for DIS."""
    devices = devices_table.all()
    return [
        {
            "id": d["id"],
            "fw": d["fw"],
            "name": d.get("name") or d["id"],
            "x": d["position"]["x"],
            "y": d["position"]["y"],
        }
        for d in devices
    ]