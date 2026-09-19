# ── topic schema ──────────────────────────────────────────────────────────
# installation/<zone>/<device_id>/status     retained, LWT   -> "online" | "offline"
# installation/<zone>/<device_id>/announce   retained        -> {type, capabilities, fw}
# installation/<zone>/<device_id>/telemetry                  -> {...}
# installation/<zone>/<device_id>/config     retained        -> {...}  (currently-set config, per device — not every device publishes this)
# installation/<zone>/<device_id>/audio_ack                  -> {filename}  (device confirms it saved the file it was told to download — backend deletes its staged copy; not every device publishes this)
# installation/<zone>/<device_id>/cmd/<capability>           <- backend publishes, device subscribes
# installation/broadcast/<type>/cmd/<capability>              <- backend publishes, all devices of a type subscribe

TOPIC_STATUS_WILD     = "installation/+/+/status"
TOPIC_ANNOUNCE_WILD   = "installation/+/+/announce"
TOPIC_TELEMETRY_WILD  = "installation/+/+/telemetry"
TOPIC_CONFIG_WILD     = "installation/+/+/config"
TOPIC_AUDIO_ACK_WILD  = "installation/+/+/audio_ack"


def cmd_topic(zone: str, device_id: str, capability: str) -> str:
    return f"installation/{zone}/{device_id}/cmd/{capability}"


def broadcast_topic(device_type: str, capability: str) -> str:
    return f"installation/broadcast/{device_type}/cmd/{capability}"


def parse_topic(topic: str):
    """Returns (zone, device_id, kind) for a status/announce/telemetry topic,
    or None if the topic doesn't match the expected 4-part shape."""
    parts = topic.split("/")
    if len(parts) != 4:
        return None
    _, zone, device_id, kind = parts
    return zone, device_id, kind
