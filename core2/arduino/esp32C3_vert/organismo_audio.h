#ifndef ORGANISMO_AUDIO_H
#define ORGANISMO_AUDIO_H

// Audio upload/download for esp32C3_organismo ONLY — not part of the
// shared device_base.h. Flow: the frontend uploads a file to the backend,
// which stages it on disk and sends this device an AUDIO_UPDATE command
// with a URL; this device pulls it down over plain HTTP (same idea as
// device_base.h's OTA UPDATE, just writing to LittleFS instead of program
// flash) and stores it under a fixed on-device name, then tells the
// backend it can delete its staged copy. `audioFile` (declared in the
// .ino, before organismo_config.h) holds the *original* filename purely as
// bookkeeping — the device itself always just plays whatever's at
// AUDIO_PATH, it never looks at the name.
#include <LittleFS.h>
#include <HTTPClient.h>
// Playback: ESP8266Audio library (Earle F. Philhower, III) — despite the
// name it supports ESP32 too. Install it from Arduino IDE's Library
// Manager ("ESP8266Audio") before compiling this sketch.
#include <AudioFileSourceLittleFS.h>
#include <AudioGeneratorWAV.h>
#include <AudioOutputI2S.h>

#define AUDIO_PATH "/audio.wav"  // fixed on-device filename — always this, whatever the upload was called

char topicAudioAck[80];  // "installation/<zone>/<chip_id>/audio_ack"

// Playback objects for AUDIO_PLAY — built once in setupAudio() (i2sOut,
// pinned to LRC/BLCK/DIN below) and (re)created per-play in
// handleAudioPlay() (wavSource/wavGen). Not named `audioFile` (that's
// already the char[] holding the original uploaded filename, declared in
// the .ino).
static AudioOutputI2S *i2sOut = nullptr;
static AudioFileSourceLittleFS *wavSource = nullptr;
static AudioGeneratorWAV *wavGen = nullptr;

// Call once in setup(), after setupConfig() (needs configPrefs already
// open, and ZONE/chipIDStr from setupNetwork()).
void setupAudio() {
    // begin(true)'s built-in format-on-fail only reliably recovers a blank/
    // erased partition — a partition that already has *some* (corrupted,
    // or leftover-from-a-different-sketch) filesystem structure on it often
    // just fails and returns false without actually reformatting (that's
    // the "Corrupted dir pair ... mount failed (-84)" you get from
    // esp_littlefs in that case). So on failure we force an explicit
    // format ourselves and retry the mount once — this only ever wipes a
    // *previous* audio file; the NVS config store is a separate flash
    // region entirely and isn't touched by any of this.
    if (!LittleFS.begin(false)) {
        Serial.println("LittleFS mount failed — formatting...");
        if (LittleFS.format() && LittleFS.begin(false)) {
            Serial.println("LittleFS formatted and mounted OK");
        } else {
            Serial.println("WARNING: LittleFS format/mount failed — audio download will not work. "
                            "Check Tools > Partition Scheme in Arduino IDE actually reserves a "
                            "SPIFFS/LittleFS region (not \"No FS\").");
        }
    }
    Serial.printf("LittleFS: %u/%u bytes used\n", (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());

    snprintf(topicAudioAck, sizeof(topicAudioAck), "installation/%s/%s/audio_ack", ZONE, chipIDStr);

    // Restore whatever filename was last recorded, so config reflects
    // reality (an actual file already on flash) right after boot, without
    // waiting for a new upload.
    String stored = configPrefs.getString("audioFile", "");
    stored.toCharArray(audioFile, sizeof(audioFile));

    // MAX98357A I2S amp — wiring per esp32C3_organismo.ino: LRC/BLCK/DIN.
    i2sOut = new AudioOutputI2S();
    i2sOut->SetPinout(BLCK, LRC, DIN);
    i2sOut->SetGain(1.0);  // real gain is set per-play in handleAudioPlay(), from `volume`
}

// AUDIO_UPDATE command: {"url": "http://.../file.wav", "filename": "birdsong.wav"}.
// Streams the file straight to LittleFS as AUDIO_PATH (overwriting whatever
// was there — no separate "swap" step, this device only ever has one audio
// file), records the original filename in config + NVS, republishes config
// so the dashboard picks up the new name, then tells the backend it's safe
// to delete its staged copy. Wired in from onCommand() in
// esp32C3_organismo.ino.
void handleAudioUpdate(JsonObject params) {
    const char* url = params["url"] | "";
    const char* filename = params["filename"] | "audio";
    if (strlen(url) == 0) {
        Serial.println("AUDIO_UPDATE: no url");
        return;
    }

    Serial.print("Audio download from: "); Serial.println(url);

    HTTPClient http;
    http.begin(url);
    int code = http.GET();
    if (code != HTTP_CODE_OK) {
        Serial.printf("AUDIO_UPDATE failed: HTTP %d\n", code);
        http.end();
        return;
    }

    // Bail out *before* touching the existing file if the incoming file
    // plainly can't fit — LittleFS.open(..., "w") below truncates whatever
    // audio file is already there first, so if we let it proceed and then
    // fail partway we'd lose a working file for nothing. A little headroom
    // because LittleFS has its own bookkeeping overhead on top of the raw
    // partition size, so "fits exactly" isn't actually safe.
    int contentLength = http.getSize();  // -1 if the server didn't send Content-Length
    if (contentLength > 0 && (size_t)contentLength + 4096 > LittleFS.totalBytes()) {
        Serial.printf("AUDIO_UPDATE: file is %d bytes but the LittleFS partition is only "
                       "%u bytes total — it will never fit. Pick a bigger partition scheme "
                       "under Tools > Partition Scheme (this is almost certainly \"Minimal "
                       "SPIFFS\", which only reserves ~190KB for the filesystem) and reflash.\n",
                       contentLength, (unsigned)LittleFS.totalBytes());
        http.end();
        return;
    }

    File f = LittleFS.open(AUDIO_PATH, "w");
    if (!f) {
        Serial.println("AUDIO_UPDATE: failed to open " AUDIO_PATH " for writing");
        http.end();
        return;
    }

    // Streamed straight from the socket to flash in small chunks rather
    // than buffered in RAM — a C3 doesn't have the RAM to hold even a
    // modest audio file whole, and there's no need to, HTTPClient exposes
    // the raw stream directly.
    WiFiClient* stream = http.getStreamPtr();
    uint8_t buf[512];
    size_t written = 0;
    int remaining = contentLength;
    bool outOfSpace = false;
    while (http.connected() && (remaining > 0 || remaining == -1)) {
        size_t avail = stream->available();
        if (avail == 0) { delay(1); continue; }
        int n = stream->readBytes(buf, avail > sizeof(buf) ? sizeof(buf) : avail);
        if (n <= 0) break;
        size_t w = f.write(buf, n);
        written += w;
        if (remaining > 0) remaining -= n;
        if (w != (size_t)n) {
            // Partition filled up mid-write (esp_littlefs logs its own "No
            // more free space" error to Serial when this happens) — stop
            // right away instead of grinding through the rest of the
            // stream hitting the same error on every remaining chunk.
            outOfSpace = true;
            break;
        }
    }
    f.close();
    http.end();

    if (outOfSpace) {
        LittleFS.remove(AUDIO_PATH);  // don't leave a truncated/corrupt file behind
        Serial.printf("AUDIO_UPDATE: ran out of space after %u bytes (partition holds %u "
                       "bytes total) — aborted and removed the partial file. Pick a bigger "
                       "partition scheme under Tools > Partition Scheme and reflash.\n",
                       (unsigned)written, (unsigned)LittleFS.totalBytes());
        return;  // no ack — the staged copy stays on the backend so a retry after
                  // reflashing with more space doesn't need a fresh upload
    }

    Serial.printf("Audio saved: %u bytes -> %s (%u/%u bytes now used on the partition)\n",
                   (unsigned)written, AUDIO_PATH,
                   (unsigned)LittleFS.usedBytes(), (unsigned)LittleFS.totalBytes());

    strncpy(audioFile, filename, sizeof(audioFile) - 1);
    audioFile[sizeof(audioFile) - 1] = '\0';
    configPrefs.putString("audioFile", audioFile);
    publishConfig();

    // Tell the backend it can delete the copy it staged for us.
    if (mqttConnected) {
        char ackBuf[96];
        snprintf(ackBuf, sizeof(ackBuf), "{\"filename\":\"%s\"}", audioFile);
        mqttClient.publish(topicAudioAck, ackBuf);
    }
}


// AUDIO_PLAY command: {} — no params needed. (Re)starts playback of
// whatever's currently saved at AUDIO_PATH, at the configured `volume`
// (0..1, same field the sliders show — unset just plays at unity gain).
// Restarting mid-playback is fine: any in-flight wavGen/wavSource is torn
// down first. Actual playback is non-blocking — tickAudio(), called every
// loop(), is what pumps samples out over I2S a chunk at a time.
void handleAudioPlay() {
    if (!audioFile[0]) {
        Serial.println("AUDIO_PLAY: no audio uploaded yet");
        return;
    }

    if (wavGen) {
        if (wavGen->isRunning()) wavGen->stop();
        delete wavGen;
        wavGen = nullptr;
    }
    if (wavSource) {
        delete wavSource;
        wavSource = nullptr;
    }

    float gain = isnan(volume) ? 1.0f : volume;
    i2sOut->SetGain(gain);

    wavSource = new AudioFileSourceLittleFS(AUDIO_PATH);
    wavGen = new AudioGeneratorWAV();
    if (!wavGen->begin(wavSource, i2sOut)) {
        Serial.println("AUDIO_PLAY: failed to start playback");
        delete wavGen; wavGen = nullptr;
        delete wavSource; wavSource = nullptr;
        return;
    }
    Serial.printf("AUDIO_PLAY: playing %s at gain %.2f\n", AUDIO_PATH, gain);
}

// Call every loop(). AudioGeneratorWAV::loop() does one bounded chunk of
// decode+I2S-write per call and returns false once the file is done, which
// is when we tear the generator/source down again (leaving them allocated
// between plays would leak and also leave the file handle open).
void tickAudio() {
    if (wavGen && wavGen->isRunning()) {
        if (!wavGen->loop()) {
            wavGen->stop();
            delete wavGen; wavGen = nullptr;
            delete wavSource; wavSource = nullptr;
            Serial.println("AUDIO_PLAY: finished");
        }
    }
}

#endif
