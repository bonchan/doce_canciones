import cv2
import socket
import time
import struct  # Added for safe byte packing

SERVER_IP = "127.0.0.1"
PORT = 9000
VIDEO_PATH = r"C:\code\doce_canciones\C04\TDYolo\video\example-1.mp4"

def stream_video():
    client_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    print(f"Connecting to J2 Core via USB on port {PORT}...")
    
    try:
        client_socket.connect((SERVER_IP, PORT))
        print("Connected successfully!")
    except Exception as e:
        print(f"Connection failed: {e}")
        return

    cap = cv2.VideoCapture(VIDEO_PATH)
    
    # Safety Check: Let's make sure OpenCV is actually opening your video file
    if not cap.isOpened():
        print(f"ERROR: Could not open or read the video file at: {VIDEO_PATH}")
        return

    print("Starting video transmission loop...")

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            print("End of video file or failed to read frame.")
            break

        # CRUCIAL FOR J2 CORE: Downscale the resolution on your PC first!
        # Blasting raw 1080p or 4K JPEGs will instantly crash the J2 Core's tiny memory heap.
        frame = cv2.resize(frame, (480, 360)) 

        # Compress to JPEG
        success, encoded_image = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if not success:
            continue

        data_bytes = encoded_image.tobytes()
        data_size = len(data_bytes)

        try:
            # >I forces an Unsigned Integer, Big-Endian standard 4-byte block
            header = struct.pack('>I', data_size)
            client_socket.sendall(header)
            
            # Send payload
            client_socket.sendall(data_bytes)
            
            # Match frame timing (~30fps)
            time.sleep(0.033)
            
        except Exception as e:
            print(f"Transmission broken: {e}")
            break

    cap.release()
    client_socket.close()
    print("Stream finished.")

if __name__ == "__main__":
    stream_video()