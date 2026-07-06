import subprocess
import time
from logger import logger

APK_PATH = r"../../core/android/build/app-debug.apk"
PACKAGE = "com.liminalia.usbvideoreceiver"
ACTIVITY = f"{PACKAGE}/.MainActivity"
CHECK_INTERVAL = 10

def adb(cmd):
    args = [r"../../MISC/platform-tools/adb.exe"]
    if isinstance(cmd, list):
        args.extend(cmd)
    else:
        args.extend(cmd.split())
        
    result = subprocess.run(args, capture_output=True, text=True)
    
    # Combine both stdout and stderr so no device errors are hidden
    out = (result.stdout + "\n" + result.stderr).strip()
    
    logger.info(f"Executing: {' '.join(args)}")
    return out

def is_app_installed():
    """Returns True if the application package exists on the target device."""
    out = adb(f"shell pm list packages {PACKAGE}")
    # pm list packages filters by string. If installed, it returns: "package:com.liminalia.usbvideoreceiver"
    return f"package:{PACKAGE}" in out

def install_apk():
    """Executes a physical background installation stream to the device panel."""
    logger.info(f"📦 Target package missing. Deploying payload: {APK_PATH}")
    
    out = adb(["install", "-r", "-t", APK_PATH])
    logger.info(f"Device Registry Output: {out}")
    
    if "success" in out.lower():
        logger.info("✅ APK installed successfully!")
        return True
    else:
        logger.error(f"❌ Installation explicitly dropped by device.")
        return False


def is_device_connected():
    out = adb("devices")
    lines = [l for l in out.splitlines() if "\tdevice" in l]
    return len(lines) > 0

def get_screen_power_state():
    """Returns 0 if screen is totally black/off, 3 if backlights are alive."""
    power_info = adb("shell dumpsys power")
    power_info_lower = power_info.lower() # Standard Python string operation
    
    if "mpowerstate=0" in power_info_lower or "display power: state=off" in power_info_lower or "mwakefulness=asleep" in power_info_lower:
        return 0
        
    return 3

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
            return PACKAGE in line and ".MainActivity" in line
    return False

def wake_and_unlock():
    logger.info("⚡ Running wake engine sequence...")
    
    # 1. Prevent the tablet from falling back asleep over USB
    adb("shell svc power stayon usb")
    time.sleep(0.1)
    
    # 2. Explicitly force a hardware screen wake up call
    adb("shell input keyevent KEYCODE_WAKEUP")
    time.sleep(0.3)
    
    # # 3. Send a Menu key event (on many Android versions, this dismisses standard slide lockscreens instantly)
    # adb("shell input keyevent KEYCODE_MENU")
    # time.sleep(0.3)
    
    # 4. Fallback: Simulate a swipe from the bottom to the top of the screen to clear stubborn lockscreens
    # (Using generic coordinates that work across most tablet aspects)
    adb("shell input swipe 400 800 400 200 300")
    time.sleep(0.5)

def launch_activity():
    logger.info(f"🚀 Pushing application back to screen focus layer: {ACTIVITY}")
    adb(f"shell am start -n {ACTIVITY}")

def watchdog():
    logger.info("ADB watchdog initialized.")
    while True:
        try:
            if not is_device_connected():
                logger.info("connection dropped.")
            else:
                if not is_app_installed():
                    logger.warning(f"❌ CRITICAL: App {PACKAGE} is not installed on this device!")
                    installed = install_apk()
                    if not installed:
                        # Skip this cycle loop if deployment file can't be fetched
                        time.sleep(CHECK_INTERVAL)
                        continue

                power = get_screen_power_state()
                keyguard = is_keyguard_blocking()
                
                # If screen is dark or the lockscreen is up, run the sequence
                if power == 0 or keyguard:
                    logger.warning("Screen sleeping or locked — running unlock engine sequence.")
                    wake_and_unlock()
                    time.sleep(1)
                
                # Now verify if the app has screen priority focus
                if not is_app_in_foreground():
                    logger.warning("App hidden or behind launcher — bringing activity forward.")
                    launch_activity()
                else:
                    logger.info("App focused on screen. All good.")
                    
        except Exception as e:
            logger.error(f"Watchdog loop intercept: {e}")
            
        time.sleep(CHECK_INTERVAL)

if __name__ == "__main__":
    watchdog()