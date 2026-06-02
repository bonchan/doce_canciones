import numpy as np
import pandas as pd
from pvlib import solarposition
import matplotlib.pyplot as plt

# 1. Location & Settings
lat, lon = -38.9516, -68.0591 # neuquen
# lat, lon = 0,-78.8 # ecu

tz = 'America/Argentina/Salta'
months = range(1, 13)
colors = plt.cm.magma(np.linspace(0.3, 0.9, 12)) # Warm "sun" palette

fig, ax = plt.subplots(figsize=(10, 10), subplot_kw={'projection': 'polar'})
ax.set_facecolor('#1a1a1a') # Dark canvas

# 2. Plotting the monthly paths
for month in months:
    times = pd.date_range(f'2025-{month:02d}-15 00:00:00', 
                          f'2025-{month:02d}-15 23:59:00', 
                          freq='5min', tz=tz)
    
    solpos = solarposition.get_solarposition(times, lat, lon)
    sun_up = solpos[solpos['elevation'] > 0]
    
    # Polar math: 
    # theta = Azimuth in radians
    # r = 90 - Elevation (so 0 elevation is the outer edge)
    theta = np.radians(sun_up['azimuth'])
    r = 90 - sun_up['elevation']
    
    ax.plot(theta, r, color=colors[month-1], lw=2, alpha=0.8, 
            label=pd.to_datetime(f'2025-{month:02d}-01').strftime('%B'))

# 3. Aesthetics & Compass
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1) # Clockwise
ax.set_rmax(90)
ax.set_rticks([0, 30, 60, 90])
ax.set_yticklabels(['90°', '60°', '30°', '0°'], color="gray") # Elevation labels

# Labels for the Cardinal directions
ax.set_xticklabels(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], color='white', fontweight='bold')
ax.grid(True, color='#444444', linestyle='--')

plt.title("Yearly Sun Path: Neuquén, Argentina", color='white', pad=20, fontsize=16)
legend = plt.legend(loc='upper right', bbox_to_anchor=(1.2, 1), facecolor='#1a1a1a', edgecolor='none')
plt.setp(legend.get_texts(), color='white')

plt.show()