extends Node
## Device (autoload singleton)
##
## Makes this build a device on the installation's MQTT bus, speaking exactly
## the protocol the ESP32s speak -- see core2/arduino/device_base.h, which is
## the reference implementation. A brain or dashboard that already knows how to
## talk to a sensor.ldr needs to learn nothing new to talk to this.
##
##   installation/<zone>/<id>/status     "online" / "offline"    retained
##   installation/<zone>/<id>/announce   identity + capabilities retained
##   installation/<zone>/<id>/telemetry  JSON, ~1 Hz, not retained
##   installation/<zone>/<id>/cmd/<CAP>  commands addressed to us
##   installation/broadcast/<type>/cmd/<CAP>  commands to every device of our type
##
## The two retained topics are the important part of the contract: a brain that
## restarts gets the whole picture replayed by the broker without asking, and
## the last will means the broker announces us offline within seconds if this
## process dies, rather than anyone waiting on a timeout.
##
## Settings live in config.cfg, looked for BESIDE THE EXECUTABLE first so an
## installed build can be repointed without a rebuild. See _ready().

const FW_VERSION := "0.0.1"
const RETRY_INTERVAL := 10.0
const TELEMETRY_INTERVAL := 1.0
const MQTTClient := preload("res://addons/godot-mqtt/mqtt.gd")
## The addon's BCM_CONNECTED. See _link_alive() for why we read its state
## directly instead of trusting it to tell us when the link dies.
const BCM_CONNECTED := 20

## Announce metadata, exactly as on the firmware: it enforces nothing, so it is
## only worth anything if it stays honest. Every name below is handled -- do
## not add one here until it is.
const PUBLISHES := ["fps", "speed", "heading", "preset", "animals", "pilot",
	"pilot_active", "wind", "wind_dir", "wind_gain", "wind_steady", "hud",
	"primitives", "grass", "fullscreen", "alter"]
const SUBSCRIBES := ["IDENTIFY", "ALTER", "PRESET", "WIND", "SPAWN", "PILOT", "DISPLAY"]

signal connected()
signal disconnected()
## A command addressed to us. The capability is read off the end of the topic
## and the payload is the params object itself -- no cmd/params wrapper around
## it, same as the firmware.
signal command(capability: String, params: Dictionary)
## Anything arriving on a topic we subscribed to via subscribe_topic().
signal message(topic: String, payload: String)
## Fired just before telemetry goes out. Fill the dictionary in; several
## listeners can each add their own fields.
signal collect_telemetry(into: Dictionary)
## IDENTIFY -- make yourself known, for this many seconds.
signal identify(duration: float)
## Fired while building the announce. Add anything a dashboard needs in order
## to offer sensible controls -- the list of presets, the list of species. The
## backend keeps unknown announce fields in dev["meta"] and hands them to the
## page as-is, the same way the polargraph advertises its geometry.
signal collect_announce(into: Dictionary)

var online: bool = false
var device_id: String = ""
var zone: String = "unknown"
var device_type: String = "display.unknown"
var device_name: String = "godot"
var wind_topic: String = ""

## Kept so anything else can read its own section without loading the file
## again -- see setting().
var _cfg: ConfigFile
var _client: Node
var _enabled: bool = false
var _broker := ""
var _user := ""
var _pass := ""
var _retry: float = 0.0
var _telemetry: float = 0.0
var _extra_topics: PackedStringArray = []

var _t_status := ""
var _t_announce := ""
var _t_telemetry := ""
var _t_cmd := ""        # installation/<zone>/<id>/cmd/
var _t_broadcast := ""  # installation/broadcast/<type>/cmd/


func _ready() -> void:
	var cfg := ConfigFile.new()
	_cfg = cfg
	# Beside the executable FIRST. The whole point of this file is that the
	# gallery machine can be repointed -- different broker, zone, fullscreen --
	# without a rebuild, and res:// lives inside the .pck where nothing can be
	# edited. res:// is last so it still works when running from the editor,
	# and so an export can ship a default.
	var tried: PackedStringArray = []
	var loaded := false
	for path in [
			OS.get_executable_path().get_base_dir().path_join("config.cfg"),
			"user://config.cfg",
			"res://config.cfg"]:
		tried.append(path)
		if cfg.load(path) == OK:
			print("[device] config: ", path)
			loaded = true
			break
	if not loaded:
		print("[device] no config.cfg in any of %s -- staying off the bus" % ", ".join(tried))
		return
	_enabled = cfg.get_value("mqtt", "enabled", true)
	_broker = cfg.get_value("mqtt", "broker_url", "tcp://localhost:1883")
	_user = cfg.get_value("mqtt", "username", "")
	_pass = cfg.get_value("mqtt", "password", "")
	zone = cfg.get_value("device", "zone", "unknown")
	device_type = cfg.get_value("device", "type", "display.unknown")
	device_name = cfg.get_value("device", "name", "godot")
	wind_topic = cfg.get_value("wind", "topic", "")

	# The firmware uses the eFuse MAC as 12 hex digits. We have no such thing,
	# so fold the machine unique id down to the same shape -- stable across
	# runs on one machine, and the topics keep an identical form.
	var raw := OS.get_unique_id()
	if raw.is_empty():
		raw = OS.get_processor_name() + OS.get_model_name()
	device_id = "%012X" % (hash(raw) & 0xFFFFFFFF)

	_t_status = "installation/%s/%s/status" % [zone, device_id]
	_t_announce = "installation/%s/%s/announce" % [zone, device_id]
	_t_telemetry = "installation/%s/%s/telemetry" % [zone, device_id]
	_t_cmd = "installation/%s/%s/cmd/" % [zone, device_id]
	_t_broadcast = "installation/broadcast/%s/cmd/" % device_type

	print("[device] id %s | zone %s | type %s | fw %s" % [device_id, zone, device_type, FW_VERSION])
	if not _enabled:
		print("[device] mqtt disabled in config.cfg")
		return
	if not wind_topic.is_empty():
		_extra_topics.append(wind_topic)
	_open()


## Subscribe to something outside our own device tree -- how WindInput gets at
## the anemometer telemetry. Safe to call before we are connected; the list is
## replayed on every (re)connect.
func subscribe_topic(topic: String) -> void:
	if topic.is_empty() or topic in _extra_topics:
		return
	_extra_topics.append(topic)
	if online:
		_client.subscribe(topic)
		print("[device] subscribed ", topic)


## Read anything else out of config.cfg. This autoload is the only thing that
## loads the file, so other scripts come through here rather than each parsing
## it again -- and they still work if the file is missing.
func setting(section: String, key: String, fallback: Variant) -> Variant:
	if _cfg == null:
		return fallback
	return _cfg.get_value(section, key, fallback)


func publish_json(topic: String, data: Dictionary, retain: bool = false) -> void:
	if online:
		_client.publish(topic, JSON.stringify(data), retain)


# ------------------------------------------------------------------ connection

## A fresh client per attempt. The addon asserts it is in NOCONNECTION state
## when connect_to_broker() is called, so reusing one after a failure is a coin
## toss -- building a new one is cheap and always valid.
func _open() -> void:
	if _client != null and is_instance_valid(_client):
		# Stop it processing and get it out of the tree NOW, not at the end of
		# the frame -- a queue_free()d client keeps running its _process and
		# keeps pinging the dead socket until then.
		_client.set_process(false)
		remove_child(_client)
		_client.queue_free()
	_client = MQTTClient.new()
	_client.client_id = "%s-%s" % [device_name, device_id]
	_client.verbose_level = 0
	add_child(_client)
	_client.broker_connected.connect(_on_connected)
	_client.broker_disconnected.connect(_on_dropped)
	_client.broker_connection_failed.connect(_on_failed)
	_client.received_message.connect(_on_message)
	if not _user.is_empty():
		_client.set_user_pass(_user, _pass)
	# Last will: if this process dies, the broker says so on our behalf.
	_client.set_last_will(_t_status, "offline", true, 1)
	_retry = RETRY_INTERVAL
	print("[device] connecting to ", _broker)
	_client.connect_to_broker(_broker)


func _process(delta: float) -> void:
	if not _enabled:
		return
	if not online:
		_retry -= delta
		if _retry <= 0.0:
			print("[device] retrying...")
			_open()
		return
	if not _link_alive():
		print("[device] link died -- reconnecting in %ds" % int(RETRY_INTERVAL))
		_on_dropped()
		return
	_telemetry -= delta
	if _telemetry <= 0.0:
		_telemetry = TELEMETRY_INTERVAL
		_publish_telemetry()


## Is the socket actually still there?
##
## We cannot ask the addon, because it does not know. Its _process calls
## receiveintobuffer(), which DOES detect a dead socket and returns FAILED --
## but the return value is discarded and brokerconnectmode is left at
## BCM_CONNECTED forever. So broker_disconnected never fires, and anything
## waiting on that signal waits for good while the log fills up with
## "bad senddata packet E=1" from pings into a closed socket.
##
## So we look at the socket ourselves. This is the difference between a piece
## that survives a broker restart overnight and one that quietly goes deaf.
func _link_alive() -> bool:
	if _client == null or not is_instance_valid(_client):
		return false
	if _client.brokerconnectmode != BCM_CONNECTED:
		return false
	var s: StreamPeerTCP = _client.socket
	if s != null and s.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return false
	return true


func _on_connected() -> void:
	online = true
	print("[device] connected as ", device_id)
	_client.subscribe(_t_cmd + "#")
	_client.subscribe(_t_broadcast + "#")
	for t in _extra_topics:
		_client.subscribe(t)
		print("[device] subscribed ", t)
	# Retained, so a brain that starts later still sees us.
	_client.publish(_t_status, "online", true)
	var extra: Dictionary = {}
	collect_announce.emit(extra)
	var payload: Dictionary = {
		"type": device_type,
		"fw": FW_VERSION,
		"sn": device_name,
		"capabilities": {"publishes": PUBLISHES, "subscribes": SUBSCRIBES},
	}
	payload.merge(extra)
	_client.publish(_t_announce, JSON.stringify(payload), true)
	connected.emit()


func _on_dropped() -> void:
	if online:
		print("[device] disconnected")
	online = false
	_retry = RETRY_INTERVAL
	disconnected.emit()


func _on_failed() -> void:
	online = false
	_retry = RETRY_INTERVAL
	print("[device] connection failed -- retrying in %ds" % int(RETRY_INTERVAL))


# ------------------------------------------------------------------- messages

func _on_message(topic: String, payload: String) -> void:
	# A command is identified by the capability on the end of the topic, either
	# addressed to us or to every device of our type.
	var cap := ""
	if topic.begins_with(_t_cmd):
		cap = topic.substr(_t_cmd.length())
	elif topic.begins_with(_t_broadcast):
		cap = topic.substr(_t_broadcast.length())
	if cap.is_empty():
		message.emit(topic, payload)
		return
	var params: Dictionary = {}
	if not payload.strip_edges().is_empty():
		var parsed: Variant = JSON.parse_string(payload)
		if parsed is Dictionary:
			params = parsed
	print("[device] CMD ", cap, " ", params)
	_handle_base(cap, params)
	command.emit(cap, params)


## IDENTIFY works on every device regardless of what else it does, so it is
## handled here rather than left to a listener. UPDATE is an OTA flash on the
## ESP32s and has no meaning for a desktop build.
func _handle_base(cap: String, params: Dictionary) -> void:
	match cap:
		"IDENTIFY":
			identify.emit(float(params.get("duration", 2000)) / 1000.0)
		"UPDATE":
			print("[device] UPDATE ignored -- no OTA for a desktop build")


func _publish_telemetry() -> void:
	var doc: Dictionary = {}
	collect_telemetry.emit(doc)
	doc["fps"] = Engine.get_frames_per_second()
	doc["uptime"] = int(Time.get_ticks_msec() / 1000)
	_client.publish(_t_telemetry, JSON.stringify(doc))


func _notification(what: int) -> void:
	# Say goodbye properly, so the broker does not have to fire the last will.
	if what == NOTIFICATION_WM_CLOSE_REQUEST or what == NOTIFICATION_PREDELETE:
		if online and _client != null:
			_client.publish(_t_status, "offline", true)
			_client.disconnect_from_server()
			online = false
