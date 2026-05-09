import numpy as np
import pandas as pd
from pvlib import solarposition, clearsky, atmosphere
import matplotlib.pyplot as plt

# Neuquén Settings
lat, lon = -38.9516, -68.0591
tz = 'America/Argentina/Salta'
alt = 270 # Altitude in meters

fig, ax = plt.subplots(figsize=(10, 10), subplot_kw={'projection': 'polar'})
ax.set_facecolor('#0f0f0f')

# 12 Months Average Highs for Neuquén (approximate)
avg_temps = [33, 31, 27, 21, 16, 13, 13, 16, 19, 24, 28, 32]

for i, month in enumerate(range(1, 13)):
    times = pd.date_range(f'2025-{month:02d}-15 00:00:00', 
                          f'2025-{month:02d}-15 23:59:00', freq='10min', tz=tz)
    
    # 1. Position
    solpos = solarposition.get_solarposition(times, lat, lon)
    sun_up = solpos[solpos['elevation'] > 0]
    
    # 2. Intensity (Global Horizontal Irradiance)
    # Uses Ineichen model to estimate W/m^2
    airmass = atmosphere.get_relative_airmass(sun_up['apparent_zenith'])
    cs = clearsky.ineichen(sun_up['apparent_zenith'], airmass, linke_turbidity=3, altitude=alt)
    intensity = cs['ghi'] # Global Horizontal Irradiance
    
    # 3. Polar coordinates
    theta = np.radians(sun_up['azimuth'])
    r = 90 - sun_up['elevation']
    
    # 4. Variation: Thickness (Intensity) and Color (Temperature)
    # Map intensity (0-1000) to linewidth (0.5-5)
    widths = (intensity / 1000) * 5 + 0.5
    
    # Scatter plot allows us to vary color/size along the line
    sc = ax.scatter(theta, r, c=[avg_temps[i]]*len(r), s=widths**2, 
                    cmap='inferno', vmin=10, vmax=35, alpha=0.6)

# Aesthetics
ax.set_theta_zero_location('N')
ax.set_theta_direction(-1)
ax.set_rmax(90)
ax.set_rticks([0, 30, 60, 90])
ax.set_yticklabels(['', '', '', ''], color="gray")
ax.set_xticklabels(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], color='white')
ax.grid(True, color='#333333')

cbar = plt.colorbar(sc, ax=ax, pad=0.1)
cbar.set_label('Estimated Temperature (°C)', color='white')
plt.title("Solar Intensity & Temperature Map - Neuquén", color='white', fontsize=15)
plt.show()