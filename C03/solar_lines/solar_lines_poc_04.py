import pandas as pd
from pvlib import solarposition
import matplotlib.pyplot as plt

# 1. Location & Settings
lat, lon = -38.9516, -68.0591 # Neuquén
tz = 'America/Argentina/Salta'

# 3. Create the Minimalist Square Plot
fig, ax = plt.subplots(figsize=(10, 10))
ax.set_facecolor('white')

# 2. Generate and Plot Data
for month in range(1, 13):
    # Get the 15th of each month
    times = pd.date_range(f'2025-{month:02d}-15 00:00:00', 
                          f'2025-{month:02d}-15 23:59:00', 
                          freq='10min', tz=tz)
    
    solpos = solarposition.get_solarposition(times, lat, lon)
    sun_up = solpos[solpos['elevation'] > 0].copy()
    
    # Center on North (-180 to 180)
    sun_up['adj_azimuth'] = sun_up['azimuth'].apply(lambda x: x if x <= 180 else x - 360)
    sun_up = sun_up.sort_values('adj_azimuth')
    
    # Plot each month as a separate segment inside the loop
    # This prevents the "straight line" connections between months
    ax.plot(sun_up['adj_azimuth'], sun_up['elevation'], color='black', lw=1.5, solid_capstyle='round')

# Remove all styling/axes for a pure "canvas" look
ax.set_xlim(-180, 180)
ax.set_ylim(0, 90)
ax.axis('off') 

plt.savefig('solar_paths_neuquen.png', 
            dpi=300, 
            bbox_inches='tight', 
            pad_inches=0, 
            facecolor='white')
plt.show()