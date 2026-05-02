# Wave Watch modeling roadmap

## Current production approach

Wave Watch currently builds a static 14-day surf forecast by blending multiple public model solutions:

- **ECMWF WAM**
- **NCEP GFS-Wave**
- **Météo-France Wave**
- **ECMWF IFS** winds/temperature
- **NOAA GFS** winds/temperature

The app computes:

- weighted consensus wave height, period, and direction
- weighted wind and temperature fields
- a per-hour confidence score from model disagreement
- a surf score shaped by spot preferences and offshore wind alignment

## Analysis / truth data to add next

These are the main sources for improving and testing the model stack:

1. **NDBC buoy observations**
   - realtime and historical wave height / period / direction
   - best first verification target for U.S. spots
2. **CDIP archives**
   - nearshore/coastal truth closer to actual breaks than offshore buoys
   - especially useful for California calibration
3. **NOAA WAVEWATCH III / GEFS-Wave archives**
   - backtest raw forecast skill over many cycles
   - compare deterministic blend versus ensemble spread
4. **ERA5 wave reanalysis**
   - long-run climatology, bias estimates, and hindcast-style backfills
5. **Tide/current products**
   - improve spot timing once nearshore tide proxies are integrated

## Best next improvements

### 1. Spot-specific bias correction

Train post-processing adjustments for each spot or region:

- predicted wave height bias by swell direction band
- period bias by season / synoptic regime
- wind error correction near coastlines

### 2. Nearshore transformation layer

Raw offshore wave models are not the same as breaking surf. Add features for:

- bathymetry / coastal orientation
- reef/point/beach type
- directional shadowing and exposure
- local wind sheltering

### 3. Model selection by regime

Instead of one fixed blend, learn which model to trust more when:

- long-period NW swell
- mixed wind swell
- tropical cyclone swell
- summer weak-gradient conditions

### 4. Buoy-to-break nowcast correction

Use the latest buoy observation to nudge the first 0-24h forecast window.

### 5. Formal backtesting harness

Add scripts that score:

- MAE / RMSE for wave height
- period error
- directional error
- top-window ranking accuracy
- surf-score ranking versus observed quality proxies
