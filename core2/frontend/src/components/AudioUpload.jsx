import React, { useRef, useState } from 'react';

// "Upload audio" button + current filename, for devices that take an
// AUDIO_UPDATE (voices). The backend stages the file and tells the device
// to download it.
export default function AudioUpload({ deviceId, audioFile, uploadAudio }) {
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  // The <input> keeps whatever file was last picked, so re-selecting the
  // *same* file wouldn't otherwise fire a change event at all — clearing
  // its value here (before the async upload even starts) is what makes
  // clicking the button always re-prompt, every time.
  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !uploadAudio) return;
    setUploading(true);
    uploadAudio(deviceId, file).finally(() => setUploading(false));
  };

  return (
    <div className="audio-upload">
      <button
        className="jog-btn"
        disabled={uploading || !uploadAudio}
        onClick={() => fileInputRef.current && fileInputRef.current.click()}
      >
        {uploading ? 'Uploading…' : 'Upload audio'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />
      <span className="audio-filename dim">
        {audioFile ? `current: ${audioFile}` : 'no audio set'}
      </span>
    </div>
  );
}
