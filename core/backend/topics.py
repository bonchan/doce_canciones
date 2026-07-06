# SAT → NUC
SATELLITE_TELEMETRY   = "satellite/telemetry/+"
SATELLITE_STARTUP     = "satellite/startup/+"

# NUC → SAT
SYSTEM_COMMAND     = "system/command/+"
SYSTEM_COMMAND_ALL = "system/command/all"

# NUC → DIS
SYSTEM_STATE       = "system/state"
SYSTEM_CONFIG      = "system/config"
SYSTEM_EVENT       = "system/event"

# DIS → NUC
SYSTEM_HEARTBEAT   = "system/heartbeat"

# DIS → NUC
DISPLAY_TELEMETRY   = "display/telemetry/+"
DISPLAY_STARTUP     = "display/startup/+"

def satellite_telemetry(chip_id):  return SATELLITE_TELEMETRY.replace("+", chip_id)

def system_command(chip_id):       return SYSTEM_COMMAND.replace("+", chip_id)

def display_telemetry(chip_id):    return DISPLAY_TELEMETRY.replace("+", chip_id)