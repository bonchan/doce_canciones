import numpy as np
import pandas as pd
from pvlib import solarposition, clearsky, atmosphere
import matplotlib.pyplot as plt

# Neuquén Settings
lat, lon = -38.9516, -68.0591
tz = 'America/Argentina/Salta'
alt = 270 

plt.figure(figsize=(12, 6))
plt.gca().set_facecolor('#0f0f0f')

# Colors for the 12 months (Cool to Hot)
colors = plt.cm.plasma(np.linspace(0, 1, 12))




for i, month in enumerate(range(1, 13)):
    times = pd.date_range(f'2025-{month:02d}-15 00:00:00', 
                          f'2025-{month:02d}-15 23:59:00', freq='5min', tz=tz)
    
    solpos = solarposition.get_solarposition(times, lat, lon)
    sun_up = solpos[solpos['elevation'] > 0].copy()
    
    # "The Flattening Secret": Shift Azimuth so North is 0
    # This turns 0-360 into -180 to 180
    sun_up['adj_azimuth'] = sun_up['azimuth'].apply(lambda x: x if x <= 180 else x - 360)
    sun_up = sun_up.sort_values('adj_azimuth') # Ensure smooth lines
    
    # Calculate Intensity for line thickness
    airmass = atmosphere.get_relative_airmass(sun_up['apparent_zenith'])
    cs = clearsky.ineichen(sun_up['apparent_zenith'], airmass, linke_turbidity=3, altitude=alt)
    
    # # Plotting with varying intensity
    # # We use a loop or scatter to show the "glow"
    # plt.scatter(sun_up['adj_azimuth'], sun_up['elevation'], 
    #             c=cs['ghi'], s=cs['ghi']/20, cmap='inferno', 
    #             alpha=0.4, edgecolors='none')
    
    # # Main line for the "curve"
    # plt.plot(sun_up['adj_azimuth'], sun_up['elevation'], 
    #          color=colors[i], lw=1, alpha=0.8, 
    #          label=pd.to_datetime(f'2025-{month:02d}-01').strftime('%b'))

    # Use 'inferno' for the intensity glow
    plt.scatter(sun_up['adj_azimuth'], sun_up['elevation'], 
                c=cs['ghi'], s=cs['ghi']/15, # Increased size slightly for 'glow'
                cmap='inferno', 
                alpha=0.3, edgecolors='none')
    
    # Use a standard line for the month path
    plt.plot(sun_up['adj_azimuth'], sun_up['elevation'], 
             color=colors[i], lw=1.2, alpha=0.9, 
             label=pd.to_datetime(f'2025-{month:02d}-01').strftime('%b'))

# Canvas Formatting
plt.title("Flattened Solar Arcs - Neuquén (Centered on North)", color='white', fontsize=14)
plt.xlabel("Direction (North is 0°)", color='white')
plt.ylabel("Elevation (Degrees)", color='white')

# Custom X-ticks to show South-East-North-West-South
plt.xticks([-180, -90, -45, 0, 45, 90, 180], 
           ['S', 'W', 'NW', 'N', 'NE', 'E', 'S'], color='white')
plt.yticks([0, 20, 40, 60, 80], color='white')
plt.grid(True, color='#333333', linestyle='--')
plt.xlim(-180, 180)
plt.ylim(0, 90)

plt.legend(loc='upper right', facecolor='#0f0f0f', labelcolor='white', fontsize='small')
plt.tight_layout()
plt.show()