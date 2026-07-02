# SAT → NUC
SAT_TELEMETRY   = "esp32/chipid/{id}/telemetry"
SAT_STATUS      = "esp32/chipid/{id}/status"

# NUC → SAT
SAT_COMMAND     = "esp32/chipid/{id}/command"
SAT_COMMAND_ALL = "esp32/chipid/all/command"

# NUC → DIS
SYS_STATE       = "system/state"
SYS_CONFIG      = "system/config"
SYS_EVENT       = "system/event"

# DIS → NUC
SYS_HEARTBEAT   = "system/heartbeat"

def sat_telemetry(chip_id):   return SAT_TELEMETRY.replace("{id}", chip_id)
def sat_status(chip_id):      return SAT_STATUS.replace("{id}", chip_id)
def sat_command(chip_id):     return SAT_COMMAND.replace("{id}", chip_id)
