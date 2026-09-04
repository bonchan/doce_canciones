#ifndef ORGANISMO_CONFIG_H
#define ORGANISMO_CONFIG_H

// Config (module parameters) for esp32C3_organismo ONLY — not part of the
// shared device_base.h, not used by any other sketch. No generic registry:
// each config float is read/written by name, explicitly, below. Add a new
// config var? Add it in the .ino, then add its line in each of the four
// spots here (loadConfig / publishConfig / handleSetCommand — three lines).
//
// Each value is either NAN ("null" / unset, see esp32C3_organismo.ino) or a
// real number. SET assigns it directly in RAM *and* persists it to the
// ESP32's NVS flash (Preferences library), so a value configured once
// survives a reboot or a reflash — it's read back in loadConfig() at boot.
#include <Preferences.h>

static Preferences configPrefs;
static const char* CONFIG_NAMESPACE = "organismo";

char topicConfig[80];  // "installation/<zone>/<chip_id>/config"

// Call once in setup(), right after setupNetwork() (needs ZONE + chipIDStr,
// which setupNetwork() fills in) and before loadConfig().
void setupConfig() {
    configPrefs.begin(CONFIG_NAMESPACE, /*readOnly=*/false);
    snprintf(topicConfig, sizeof(topicConfig), "installation/%s/%s/config", ZONE, chipIDStr);
}

// Restores any previously-SET values from flash. A key that was never SET
// simply isn't in flash yet, so it comes back as NAN (floats) or "" (name)
// — still "unset" either way.
void loadConfig() {
    String storedName = configPrefs.getString("name", "");
    storedName.toCharArray(name, sizeof(name));

    volume           = configPrefs.getFloat("volume", NAN);
    initialPresence  = configPrefs.getFloat("initialPresence", NAN);
    entrance         = configPrefs.getFloat("entrance", NAN);
    irregularity     = configPrefs.getFloat("irregularity", NAN);
    restMovement     = configPrefs.getFloat("restMovement", NAN);
    latentVolume     = configPrefs.getFloat("latentVolume", NAN);
    duration         = configPrefs.getFloat("duration", NAN);
    expansion        = configPrefs.getFloat("expansion", NAN);
    contact          = configPrefs.getFloat("contact", NAN);
    airMovement      = configPrefs.getFloat("airMovement", NAN);
    presence         = configPrefs.getFloat("presence", NAN);
    aperture         = configPrefs.getFloat("aperture", NAN);
    meeting          = configPrefs.getFloat("meeting", NAN);
    answer           = configPrefs.getFloat("answer", NAN);
    doubt            = configPrefs.getFloat("doubt", NAN);
    appearance       = configPrefs.getFloat("appearance", NAN);
}

// Publishes whichever config vars aren't NAN. Retained, so a restarted
// brain/dashboard gets the current config replayed immediately.
void publishConfig() {
    if (!mqttConnected) return;

    JsonDocument doc;
    if (!isnan(volume))           doc["volume"] = volume;
    if (!isnan(initialPresence))  doc["initialPresence"] = initialPresence;
    if (!isnan(entrance))         doc["entrance"] = entrance;
    if (!isnan(irregularity))     doc["irregularity"] = irregularity;
    if (!isnan(restMovement))     doc["restMovement"] = restMovement;
    if (!isnan(latentVolume))     doc["latentVolume"] = latentVolume;
    if (!isnan(duration))         doc["duration"] = duration;
    if (!isnan(expansion))        doc["expansion"] = expansion;
    if (!isnan(contact))          doc["contact"] = contact;
    if (!isnan(airMovement))      doc["airMovement"] = airMovement;
    if (!isnan(presence))         doc["presence"] = presence;
    if (!isnan(aperture))         doc["aperture"] = aperture;
    if (!isnan(meeting))          doc["meeting"] = meeting;
    if (!isnan(answer))           doc["answer"] = answer;
    if (!isnan(doubt))            doc["doubt"] = doubt;
    if (!isnan(appearance))       doc["appearance"] = appearance;
    if (name[0])                  doc["name"] = name;
    if (audioFile[0])             doc["audioFile"] = audioFile;

    // 16 float fields + name + audioFile (both up to 64 chars) — sized
    // generously above that worst case (~650 bytes); serializeJson() is
    // overflow-safe (truncates + null-terminates) but warn if this ever
    // needs to grow further.
    char buf[768];
    size_t n = serializeJson(doc, buf);
    if (n >= sizeof(buf)) {
        Serial.println("WARNING: config payload truncated, buf[] too small — increase it in organismo_config.h");
        return;
    }
    mqttClient.publish(topicConfig, buf, true);  // retained
}

// SET command: key-value setter, e.g. payload {"volume": 0.8, "entrance": 1}.
// Only keys actually present in the payload are touched — that's a real
// distinction from "present but null": {"volume": null} clears volume back
// to NAN/unset (and erases it from flash, so it stays cleared after a
// reboot too) rather than being ignored like an absent key would be. Wired
// in from onCommand() in esp32C3_organismo.ino.
void handleSetCommand(JsonObject params) {
    bool changed = false;

    if (params.containsKey("name")) {
        if (params["name"].isNull()) {
            name[0] = '\0';
            configPrefs.remove("name");
        } else {
            const char* val = params["name"] | "";
            strncpy(name, val, sizeof(name) - 1);
            name[sizeof(name) - 1] = '\0';
            configPrefs.putString("name", name);
        }
        changed = true;
    }

    if (params.containsKey("volume")) {
        if (params["volume"].isNull()) { volume = NAN; configPrefs.remove("volume"); }
        else                            { volume = params["volume"]; configPrefs.putFloat("volume", volume); }
        changed = true;
    }

    if (params.containsKey("initialPresence")) {
        if (params["initialPresence"].isNull()) { initialPresence = NAN; configPrefs.remove("initialPresence"); }
        else                            { initialPresence = params["initialPresence"]; configPrefs.putFloat("initialPresence", initialPresence); }
        changed = true;
    }

    if (params.containsKey("entrance")) {
        if (params["entrance"].isNull()) { entrance = NAN; configPrefs.remove("entrance"); }
        else                            { entrance = params["entrance"]; configPrefs.putFloat("entrance", entrance); }
        changed = true;
    }

    if (params.containsKey("irregularity")) {
        if (params["irregularity"].isNull()) { irregularity = NAN; configPrefs.remove("irregularity"); }
        else                            { irregularity = params["irregularity"]; configPrefs.putFloat("irregularity", irregularity); }
        changed = true;
    }

    if (params.containsKey("restMovement")) {
        if (params["restMovement"].isNull()) { restMovement = NAN; configPrefs.remove("restMovement"); }
        else                            { restMovement = params["restMovement"]; configPrefs.putFloat("restMovement", restMovement); }
        changed = true;
    }

    if (params.containsKey("latentVolume")) {
        if (params["latentVolume"].isNull()) { latentVolume = NAN; configPrefs.remove("latentVolume"); }
        else                            { latentVolume = params["latentVolume"]; configPrefs.putFloat("latentVolume", latentVolume); }
        changed = true;
    }

    if (params.containsKey("duration")) {
        if (params["duration"].isNull()) { duration = NAN; configPrefs.remove("duration"); }
        else                            { duration = params["duration"]; configPrefs.putFloat("duration", duration); }
        changed = true;
    }

    if (params.containsKey("expansion")) {
        if (params["expansion"].isNull()) { expansion = NAN; configPrefs.remove("expansion"); }
        else                            { expansion = params["expansion"]; configPrefs.putFloat("expansion", expansion); }
        changed = true;
    }

    if (params.containsKey("contact")) {
        if (params["contact"].isNull()) { contact = NAN; configPrefs.remove("contact"); }
        else                            { contact = params["contact"]; configPrefs.putFloat("contact", contact); }
        changed = true;
    }

    if (params.containsKey("airMovement")) {
        if (params["airMovement"].isNull()) { airMovement = NAN; configPrefs.remove("airMovement"); }
        else                            { airMovement = params["airMovement"]; configPrefs.putFloat("airMovement", airMovement); }
        changed = true;
    }

    if (params.containsKey("presence")) {
        if (params["presence"].isNull()) { presence = NAN; configPrefs.remove("presence"); }
        else                            { presence = params["presence"]; configPrefs.putFloat("presence", presence); }
        changed = true;
    }

    if (params.containsKey("aperture")) {
        if (params["aperture"].isNull()) { aperture = NAN; configPrefs.remove("aperture"); }
        else                            { aperture = params["aperture"]; configPrefs.putFloat("aperture", aperture); }
        changed = true;
    }

    if (params.containsKey("meeting")) {
        if (params["meeting"].isNull()) { meeting = NAN; configPrefs.remove("meeting"); }
        else                            { meeting = params["meeting"]; configPrefs.putFloat("meeting", meeting); }
        changed = true;
    }

    if (params.containsKey("answer")) {
        if (params["answer"].isNull()) { answer = NAN; configPrefs.remove("answer"); }
        else                            { answer = params["answer"]; configPrefs.putFloat("answer", answer); }
        changed = true;
    }

    if (params.containsKey("doubt")) {
        if (params["doubt"].isNull()) { doubt = NAN; configPrefs.remove("doubt"); }
        else                            { doubt = params["doubt"]; configPrefs.putFloat("doubt", doubt); }
        changed = true;
    }

    if (params.containsKey("appearance")) {
        if (params["appearance"].isNull()) { appearance = NAN; configPrefs.remove("appearance"); }
        else                            { appearance = params["appearance"]; configPrefs.putFloat("appearance", appearance); }
        changed = true;
    }

    if (changed) publishConfig();
}

#endif
