# mqtt_manager.gd
extends Node

@onready var drone_node = $"/root/World/Camera3D"

# Points directly to the code snippet client script you provided
const MQTTClientScript = preload("res://addons/godot-mqtt/mqtt.gd") 
var client: Node

# Using a standard, free public broker with the TCP protocol prefix
@export var mqtt_enabled: bool = false

var broker_url: String = "tcp://broker.hivemq.com:1883"
var client_id: String = "godot_fallback_client"
var topic: String = "display/telemetry/DEVICE_ID"

func _ready():
	if !mqtt_enabled:
		print("MQTT Disabled")
		return
		
	var config = ConfigFile.new()
	var error = config.load("res://config.cfg")
	
	var username = ""
	var password = ""
	
	if error == OK:
		# Extract variables safely (Using defaults if a specific key is missing)
		broker_url = config.get_value("mqtt", "broker_url", broker_url)
		client_id = config.get_value("mqtt", "client_id", client_id)
		username = config.get_value("mqtt", "username", "")
		password = config.get_value("mqtt", "password", "")
		topic = config.get_value("mqtt", "topic", "")
		print("MQTT Config successfully loaded from disk.")
	else:
		print("Warning: Could not load config.cfg (Error code: ", error, "). Using default fallback values.")
		return
		
	# 1. Instantiate the script as a node and add it to the scene tree
	client = MQTTClientScript.new()
	client.client_id = client_id
	client.verbose_level = 2 # 2 prints all inbound network messages to console
	add_child(client)
	
	# 2. Wire up the matching signals from your script
	client.broker_connected.connect(_on_mqtt_connected)
	client.received_message.connect(_on_mqtt_message_received)
	client.broker_connection_failed.connect(_on_mqtt_failed)
	
	client.set_user_pass(username, password)
	
	print("Connecting to MQTT Broker via URL: ", broker_url)
	client.connect_to_broker(broker_url)

func _on_mqtt_connected():
	print("MQTT Status: Connected successfully!")
	# Subscribe to your target topic
	client.subscribe(topic)

func _on_mqtt_failed():
	print("MQTT Status: Connection failed. Check broker URL or network connection.")

func _on_mqtt_message_received(topic: String, message: String):
	# Filter incoming messages for your target pathway
	#TODO change this
	if topic == topic:
		parse_telemetry_payload(message)


func sanitize_char(c: String) -> String:
	c = c.to_upper()
	match c:
		"Á": return "A"
		"É": return "E"
		"Í": return "I"
		"Ó": return "O"
		"Ú": return "U"
		"Ü": return "U"
		"Ñ": return "N" # Map Ñ to standard N, or leave separate if preferred
		_: return c
		
func get_country_alphabet_value(country_name: String) -> float:
	var clean_name = country_name.strip_edges().to_upper()
	
	# Skip keyword matches completely
	if clean_name == "MUNDO" or clean_name == "":
		return -1.0 # Error fallback code
		
	# Extract the first character token and sanitize accents
	var first_char = sanitize_char(clean_name.left(1))
	
	var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	var index = alphabet.find(first_char)
	
	if index == -1:
		return -1.0 # Not a valid standard letter
		
	# Remap index array range (0 to 25) across your target value system (1 to 100)
	return remap(float(index), 0.0, 25.0, 1.0, 100.0)
		
func parse_telemetry_payload(raw_string: String):
	var json = JSON.new()
	var error = json.parse(raw_string)
	
	if error == OK:
		var data = json.get_data()
		if typeof(data) == TYPE_DICTIONARY:
			# Pull data safely using your keys
			var country = data.get("country", "Unknown")
			var year = data.get("year", "N/A")
			var co2_value = data.get("co2_value", 0.0)
			var max_co2 = data.get("max_co2_value", 0.0)
			var percentage = data.get("percentage", 0.0)
			
			# 1. TRANSLATE YEAR TO YAW HORIZON HEADING
			# Clamps values safely within limits before applying rotation formulas
			var year_val = float(year)
			year_val = clamp(year_val, 1960.0, 2025.0)
			var mapped_yaw = remap(year_val, 1960.0, 2025.0, 360.0, 0.0)
			
			# 2. TRANSLATE COUNTRY TO ALPHABET PERCENTAGE RATIO
			var mapped_speed = get_country_alphabet_value(country)
			
			# --- EXECUTION LOG VIEW ---
			print("============== DATA MAPPED ==============")
			print("Raw: ", country, " (", year, ")")
			print("Calculated Yaw Angle ($0-360): ", mapped_yaw, "°")
			
			if mapped_speed != -1.0:
				print("Alphabet Scaled Metric ($1-100): ", mapped_speed)
			else:
				print("Alphabet Scaled Metric: SKIPPED (Keyword or Invalid)")
			print("=========================================")
			
			if is_instance_valid(drone_node) and drone_node.has_method("drive_to_target"):
				drone_node.drive_to_target(mapped_yaw, mapped_speed)
				print("Sent flight targets to Drone -> Heading: ", mapped_yaw, "° | Speed power: ", mapped_speed, "%")
			
			
		else:
			print("Format warning: JSON payload is not a dictionary map.")
	else:
		print("JSON Parse Error: ", json.get_error_message())
