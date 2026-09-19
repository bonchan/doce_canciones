extends Node
## ImuInput (autoload singleton)
##
## Reads the MPU-6050 lines from the Arduino: "0,ax,ay,az,gx,gy,gz\n"
## (first field is the unused 0, accel in m/s^2, gyro in rad/s), using the
## GdSerial addon, and turns them into a tilt angle you can steer with.
##
## This is the TRANSPORT plus the sensor maths. It does not decide what the
## tilt means -- Pilot does that, and only when its source is SERIAL. Editing
## imu_default.tres here changes the port; pilot_default.tres changes feel.
##
##   accel / gyro : the raw sample, m/s^2 and rad/s
##   tilt         : (roll, pitch) in degrees, gravity-referenced, zeroed to
##                  whatever "upright" was when you calibrated. Lean right ->
##                  roll grows; lean forward -> pitch grows (before inversion).
##   twist        : yaw rate in deg/s, straight off the gyro. Drifts if you
##                  integrate it -- use it as a rate, never as an angle.
##
## A plain MPU-6050 has no magnetometer, so there is no absolute heading here.

signal sample(accel: Vector3, gyro: Vector3)

@export var config: ImuConfig = preload("res://imu/imu_default.tres")

var accel := Vector3.ZERO
var gyro := Vector3.ZERO
var tilt := Vector2.ZERO
var twist: float = 0.0
var connected: bool = false

var _serial: GdSerial
var _buffer := ""
var _count := 0
## Filter state, in degrees, before the neutral offset is taken out.
var _raw_tilt := Vector2.ZERO
var _neutral := Vector2.ZERO
var _cal_sum := Vector2.ZERO
var _cal_samples: int = 0
var _cal_left: float = 0.0
var _seeded := false


func _ready() -> void:
	_serial = GdSerial.new()
	if config.com_port.is_empty():
		print("ImuInput: available ports: ", _serial.list_ports())
		return
	_serial.set_port(config.com_port)
	_serial.set_baud_rate(config.baud_rate)
	connected = _serial.open()
	if connected:
		print("ImuInput: opened %s @ %d" % [config.com_port, config.baud_rate])
		calibrate()
	else:
		push_warning("ImuInput: could not open %s (in use by another program?). Ports: %s"
				% [config.com_port, _serial.list_ports()])


## Take the current pose as upright. Stand still on the plank in the stance
## you want to mean "straight ahead, no turn" and call this (F6 while running).
func calibrate() -> void:
	_cal_sum = Vector2.ZERO
	_cal_samples = 0
	_cal_left = config.calibration_sec
	print("ImuInput: calibrating, hold still for %.1fs" % config.calibration_sec)


func is_calibrating() -> bool:
	return _cal_left > 0.0


func _process(delta: float) -> void:
	_read_serial()
	_update_tilt(delta)


func _read_serial() -> void:
	if not connected or not _serial.is_open():
		return
	var n := _serial.bytes_available()
	if n <= 0:
		return
	# Buffer raw bytes ourselves so a half-received line never blocks the frame.
	_buffer += _serial.read(n).get_string_from_utf8()
	var lines := _buffer.split("\n")
	_buffer = lines[lines.size() - 1]
	for i in lines.size() - 1:
		_handle_line(lines[i].strip_edges())


func _handle_line(line: String) -> void:
	var f := line.split(",")
	if f.size() != 7 or not f[1].is_valid_float():
		print("ImuInput: ", line)  # boot chatter
		return
	accel = Vector3(float(f[1]), float(f[2]), float(f[3]))
	gyro = Vector3(float(f[4]), float(f[5]), float(f[6]))
	sample.emit(accel, gyro)
	_count += 1
	if config.print_values and _count % config.print_every == 0:
		print("IMU accel(%.2f, %.2f, %.2f) gyro(%.3f, %.3f, %.3f)  tilt(%.1f, %.1f)" % [
			accel.x, accel.y, accel.z, gyro.x, gyro.y, gyro.z, tilt.x, tilt.y])


## Complementary filter. The accelerometer knows which way is down but picks up
## every footstep; the gyro is smooth but drifts. Trusting the gyro short-term
## and letting the accelerometer pull it straight long-term gives an angle that
## is both steady underfoot and drift-free.
func _update_tilt(delta: float) -> void:
	if accel.length_squared() < 0.01:
		return  # nothing received yet
	# Gravity sits on +Z when the plank is flat, so Z is the reference axis.
	var accel_tilt := Vector2(
			rad_to_deg(atan2(accel.x, accel.z)),
			rad_to_deg(atan2(accel.y, accel.z)))
	if not _seeded:
		_seeded = true
		_raw_tilt = accel_tilt  # start where we are, don't swing in from zero
	# Rotation about Y tips us left/right, about X tips us fore/aft.
	var rate := Vector2(rad_to_deg(gyro.y), rad_to_deg(gyro.x))
	var a: float = config.gyro_trust
	_raw_tilt = (_raw_tilt + rate * delta) * a + accel_tilt * (1.0 - a)
	twist = rad_to_deg(gyro.z)

	if _cal_left > 0.0:
		_cal_left -= delta
		_cal_sum += _raw_tilt
		_cal_samples += 1
		if _cal_left <= 0.0 and _cal_samples > 0:
			_neutral = _cal_sum / float(_cal_samples)
			print("ImuInput: neutral = (%.1f, %.1f) deg" % [_neutral.x, _neutral.y])

	tilt = _raw_tilt - _neutral


func _exit_tree() -> void:
	if _serial and _serial.is_open():
		_serial.close()
