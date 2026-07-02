import subprocess
import time

PACKAGE = "com.liminalia.usbvideoreceivertablet2"
ACTIVITY = f"{PACKAGE}/.CanvasActivity"
CHECK_INTERVAL = 10

def adb(cmd):
    args = [r"MISC\platform-tools\adb.exe"]
    if isinstance(cmd, list):
        args.extend(cmd)
    else:
        args.extend(cmd.split())
        
    result = subprocess.run(args, capture_output=True, text=True)
    out = result.stdout.strip()
    print("----------")
    print(f"Executing: {' '.join(args)}")
    print(out)
    return out

def is_device_connected():
    out = adb("devices")
    lines = [l for l in out.splitlines() if "\tdevice" in l]
    return len(lines) > 0

def get_screen_power_state():
    """Returns 0 if screen is totally black/off, 3 if backlights are alive."""
    power_info = adb("shell dumpsys power")
    for line in power_info.splitlines():
        if "mPowerState=" in line:
            # Isolate the state number
            if "mPowerState=0" in line:
                return 0
            if "mPowerState=3" in line or "SCREEN_BRIGHT_BIT" in line:
                return 3
    return 3 # Default assumption if parsing fails

def is_keyguard_blocking():
    """Checks if the security lockscreen is active on top of the window layer."""
    window_info = adb("shell dumpsys window windows")
    for line in window_info.splitlines():
        if "mCurrentFocus=" in line:
            return "Keyguard" in line
    return False

def is_app_in_foreground():
    window_info = adb("shell dumpsys window windows")
    for line in window_info.splitlines():
        if "mCurrentFocus=" in line:
            return PACKAGE in line and ".CanvasActivity" in line
    return False

def wake_and_unlock():
    power = get_screen_power_state()
    
    if power == 0:
        print("⚡ Deep sleep kernel lock detected. Forcing Power Service override...")
        
        # 1. Force the power manager to keep the screen alive while plugged into USB
        adb("shell svc power stayon usb")
        time.sleep(0.3)
        
        # 2. Force the screen state awake via the system power service controller
        # On old Android builds, sending a fake user activity poke forces an instant wake
        adb("shell input keyevent KEYCODE_HOME") 
        time.sleep(0.5)
    else:
        print("💡 Screen backlight layer is already active.")

def launch_activity():
    print(f"🚀 Pushing application back to screen focus layer: {ACTIVITY}")
    adb(f"shell am start -n {ACTIVITY}")

def watchdog():
    print("ADB watchdog initialized.")
    while True:
        try:
            if not is_device_connected():
                print("Tablet connection dropped.")
            else:
                power = get_screen_power_state()
                keyguard = is_keyguard_blocking()
                
                # If screen is dark or the lockscreen is up, run the sequence
                if power == 0 or keyguard:
                    print("Screen sleeping or locked — running unlock engine sequence.")
                    wake_and_unlock()
                    time.sleep(1)
                
                # Now verify if the app has screen priority focus
                if not is_app_in_foreground():
                    print("App hidden or behind launcher — bringing activity forward.")
                    launch_activity()
                else:
                    print("App focused on screen. All good.")
                    
        except Exception as e:
            print(f"Watchdog loop intercept: {e}")
            
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    watchdog()