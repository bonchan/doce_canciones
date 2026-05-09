import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import serial
import serial.tools.list_ports
import time
import threading
import math
from PIL import Image, ImageOps

class PolargraphGUI:
    def __init__(self, root):
        self.root = root
        self.root.title("Bluepill Polargraph Controller")
        self.ser = None
        self.drawing_thread = None
        self.stop_requested = False
        self.points_to_draw = []
        self.current_img = None

        # Configuration
        self.canvas_size_mm = 200 
        self.scale = 2             
        self.origin_x = 200        
        self.origin_y = 400        

        self.setup_ui()

    def setup_ui(self):
        control_frame = ttk.Frame(self.root, padding="10")
        control_frame.pack(side=tk.LEFT, fill=tk.Y)

        # Serial Connection
        ttk.Label(control_frame, text="Serial Port:").pack()
        self.port_combo = ttk.Combobox(control_frame)
        self.port_combo['values'] = [p.device for p in serial.tools.list_ports.comports()]
        self.port_combo.pack()

        self.btn_text = tk.StringVar()
        self.btn_text.set("Connect")
        ttk.Button(control_frame, textvariable=self.btn_text, command=self.toggle_serial).pack(pady=5)

        # Movement Buttons
        ttk.Separator(control_frame).pack(fill=tk.X, pady=10)
        self.step_entry = ttk.Entry(control_frame); self.step_entry.insert(0, "10"); self.step_entry.pack()
        
        btn_grid = ttk.Frame(control_frame); btn_grid.pack(pady=5)
        ttk.Button(btn_grid, text="▲", width=5, command=lambda: self.move_rel(0, 1)).grid(row=0, column=1)
        ttk.Button(btn_grid, text="◀", width=5, command=lambda: self.move_rel(-1, 0)).grid(row=1, column=0)
        ttk.Button(btn_grid, text="▶", width=5, command=lambda: self.move_rel(1, 0)).grid(row=1, column=2)
        ttk.Button(btn_grid, text="▼", width=5, command=lambda: self.move_rel(0, -1)).grid(row=2, column=1)

        ttk.Button(control_frame, text="ZERO", command=lambda: self.send_cmd("ZERO")).pack(fill=tk.X, pady=2)
        ttk.Button(control_frame, text="HOME", command=lambda: self.send_cmd("HOME")).pack(fill=tk.X, pady=2)
        ttk.Button(control_frame, text="HALT", command=lambda: self.send_cmd("HALT")).pack(fill=tk.X, pady=2)

        # Image Logic
        ttk.Separator(control_frame).pack(fill=tk.X, pady=10)
        ttk.Label(control_frame, text="Darkness Threshold:").pack()
        # Added command=self.process_image to update live
        self.threshold = tk.Scale(control_frame, from_=0, to=255, orient=tk.HORIZONTAL, command=lambda x: self.process_image())
        self.threshold.set(128)
        self.threshold.pack(fill=tk.X)
        
        ttk.Button(control_frame, text="LOAD IMAGE", command=self.load_image_file).pack(fill=tk.X, pady=5)
        ttk.Button(control_frame, text="SIMULATE PATH", command=self.simulate_path).pack(fill=tk.X)
        
        # Draw Controls
        self.continuous_var = tk.BooleanVar()
        ttk.Checkbutton(control_frame, text="Continuous Loop", variable=self.continuous_var).pack(anchor=tk.W)
        
        ttk.Button(control_frame, text="DRAW", command=self.start_draw_thread).pack(fill=tk.X, pady=2)
        ttk.Button(control_frame, text="STOP", command=self.stop_drawing).pack(fill=tk.X, pady=2)

        # Canvas
        self.canvas = tk.Canvas(self.root, width=400, height=400, bg="white")
        self.canvas.pack(side=tk.RIGHT, padx=10, pady=10)
        self.draw_grid()

    def draw_grid(self):
        for i in range(0, 401, 20):
            self.canvas.create_line(i, 0, i, 400, fill="#ddd")
            self.canvas.create_line(0, i, 400, i, fill="#ddd")
        self.canvas.create_line(200, 0, 200, 400, fill="red")

    def load_image_file(self):
        path = filedialog.askopenfilename()
        if not path: return
        self.current_img = Image.open(path).convert('L')
        self.current_img = ImageOps.contain(self.current_img, (200, 200))
        self.process_image()

    def process_image(self):
        if self.current_img is None: return
        
        width, height = self.current_img.size
        thresh = self.threshold.get()
        
        # 1. Collect all pixels below threshold
        raw_points = []
        for y in range(height):
            for x in range(width):
                if self.current_img.getpixel((x, y)) < thresh:
                    mm_x = x - (width / 2)
                    mm_y = (height - y)
                    raw_points.append([mm_x, mm_y]) # Using list for easy modification
        
        # 2. POLISH TRACE (Thinning/Decimation)
        # We only keep points that are at least 1.2mm away from each other
        # This prevents the "back and forth" on a thick line
        polished_points = []
        min_separation = 1.2  # Adjust this to change line detail (in mm)
        
        temp_points = raw_points.copy()
        while temp_points:
            p = temp_points.pop(0)
            polished_points.append(p)
            # Remove all other points that are too close to this one
            temp_points = [other for other in temp_points if 
                           math.sqrt((p[0]-other[0])**2 + (p[1]-other[1])**2) > min_separation]

        # 3. PATH OPTIMIZATION (Nearest Neighbor)
        self.points_to_draw = []
        if polished_points:
            current_pos = (0, 0)
            while polished_points:
                closest_idx = 0
                min_dist = float('inf')
                for i, p in enumerate(polished_points):
                    d = math.sqrt((p[0]-current_pos[0])**2 + (p[1]-current_pos[1])**2)
                    if d < min_dist:
                        min_dist = d
                        closest_idx = i
                
                next_p = polished_points.pop(closest_idx)
                self.points_to_draw.append(next_p)
                current_pos = next_p

        self.update_preview()

    def update_preview(self):
        self.canvas.delete("trace")
        for p in self.points_to_draw:
            px = self.origin_x + (p[0] * self.scale)
            py = self.origin_y - (p[1] * self.scale)
            self.canvas.create_rectangle(px, py, px+1, py+1, outline="black", tags="trace")

    def simulate_path(self):
        self.canvas.delete("sim")
        if not self.points_to_draw: return
        
        last_p = (0, 0) # Start from origin
        for p in self.points_to_draw:
            x1 = self.origin_x + (last_p[0] * self.scale)
            y1 = self.origin_y - (last_p[1] * self.scale)
            x2 = self.origin_x + (p[0] * self.scale)
            y2 = self.origin_y - (p[1] * self.scale)
            
            self.canvas.create_line(x1, y1, x2, y2, fill="red", tags="sim")
            last_p = p
            self.root.update()
            time.sleep(0.001)

    def draw_loop(self):
        while True:
            for p in self.points_to_draw:
                if self.stop_requested: return
                self.send_cmd(f"ABS X{p[0]:.2f} Y{p[1]:.2f}")
                self.wait_for_ok() 
            
            if not self.continuous_var.get(): break
            time.sleep(1)

    def wait_for_ok(self):
        if self.ser:
            start_time = time.time()
            while (time.time() - start_time) < 2.0: # 2s timeout
                if self.ser.in_waiting:
                    line = self.ser.readline().decode().strip()
                    if "arrived" in line.lower() or "disabled" in line.lower(): return
                time.sleep(0.01)

    def start_draw_thread(self):
        if not self.points_to_draw: return
        self.stop_requested = False
        self.drawing_thread = threading.Thread(target=self.draw_loop, daemon=True)
        self.drawing_thread.start()

    def stop_drawing(self):
        self.stop_requested = True

    def toggle_serial(self):
        if self.ser and self.ser.is_open:
            try:
                self.ser.close()
                self.btn_text.set("Connect")
            except Exception as e:
                messagebox.showerror("Error", f"Could not close: {e}")
        else:
            self.connect_serial()

    def connect_serial(self):
        try:
            port = self.port_combo.get()
            if not port:
                messagebox.showwarning("Warning", "Select a port first!")
                return
                
            self.ser = serial.Serial(port, 115200, timeout=0.1)
            self.btn_text.set("Disconnect")
        except Exception as e:
            messagebox.showerror("Error", f"Connection failed: {e}")

    def send_cmd(self, cmd):
        if self.ser and self.ser.is_open:
            self.ser.write((cmd + "\n").encode())

    def move_rel(self, dx, dy):
        dist = float(self.step_entry.get())
        self.send_cmd(f"REL X{dx*dist} Y{dy*dist}")

if __name__ == "__main__":
    root = tk.Tk(); app = PolargraphGUI(root); root.mainloop()