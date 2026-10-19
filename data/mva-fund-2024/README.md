# MVA Fund Road Crash & Claims Report 2024 — Extracted Dataset

Source: MVA Fund (Namibia) "Road Crash and Claims Report 2024" (PDF, provided by user).
Extracted: structured tables from the report for use as an "official statistics" 
reference layer in the Namibia road accident reporting platform.

## Important notes / caveats

- This is REGIONAL/AGGREGATE data (by region, month, day, time-of-day, crash type),
  NOT individual point-level crash records. It has no lat/lng and cannot be
  plotted as individual pins. Use it for choropleth/heatmap overlays by region,
  and for validating/benchmarking the news-extraction pipeline's regional splits.
- MVA Fund only records crashes that resulted in INJURY and/or FATALITY.
  Property-damage-only crashes are excluded from this dataset (they are recorded
  separately by Namibian Police).
- Minor internal inconsistency in the source report: Table 1 (Quick Facts) lists
  446 fatalities for 2024, while Table 10 (Fatalities per month) sums to 443.
  Both figures are reproduced as published; flagged here for awareness.
- 2023 time-of-day figures for pedestrian crashes (file 22) and rollover crashes
  (file 26) were shown only as chart markers ("*") in the source with no printed
  values, so those cells are left as "*" (not available) rather than guessed.
- Regions use the source report's spelling/naming (e.g. "//Karas", "//Kharas" —
  the source itself uses both spellings in different tables).

## Files

01_quick_facts.csv — Crashes, fatalities, injuries, casualties, claims, and rate
  indicators (per 10,000 vehicles / per 100,000 persons) 2020–2024.
02_population_casualties_by_region_2024.csv — Population and casualty rate by region.
03_crashes_per_month.csv — Monthly crash counts 2020–2024.
04_crashes_per_region.csv — Regional crash counts 2024 vs 2023.
05_crash_types.csv — Crash type breakdown (collisions, pedestrians, rollovers, etc).
06_crash_types_by_region.csv — Crash type x region cross-tab, 2024.
07_crashes_by_day_of_week_region.csv — Day-of-week x region cross-tab, 2024.
08_crashes_by_time_of_day.csv — Crashes by 2-hour time block, 2024 vs 2023.
09_vehicle_types_by_region.csv — Vehicle type x region cross-tab, 2024.
10_vehicle_use.csv — Private/Company/Public/Unknown vehicle use, 2024 vs 2023.
11_injuries_per_month.csv — Monthly injury counts 2020–2024.
12_injuries_by_region.csv — Regional injury counts 2024 vs 2023.
13_injuries_by_age_group.csv — Injuries by age group, 2024 vs 2023.
14_injuries_by_sex_and_roaduser.csv — Injuries by sex and road-user category.
15_fatalities_per_month.csv — Monthly fatality counts 2020–2024.
16_fatalities_per_region.csv — Regional fatality counts 2020–2024.
17_fatalities_by_sex_region.csv — Fatalities by sex x region, 2024.
18_fatalities_by_age_sex.csv — Fatalities by age group x sex, 2024.
19_fatalities_by_roaduser_age.csv — Fatalities by road-user category x age, 2024.
20_fatalities_roaduser_placeofdeath.csv — Fatalities by road-user category and place
  of death, 2024 vs 2023.
21_pedestrian_crashes_per_region.csv — Pedestrian crash counts/proportion by region.
22_pedestrian_crashes_time_day.csv — Pedestrian crashes by time-of-day and day-of-week.
23_pedestrian_injuries_fatalities.csv — Pedestrian injury/fatality summary by sex
  and place of death.
24_pedestrian_age_breakdown.csv — Pedestrian injuries and fatalities by age group.
25_rollover_crashes_per_region.csv — Rollover crash counts/proportion by region.
26_rollover_time_day.csv — Rollover crashes by time-of-day and day-of-week.
27_benefit_claims_trend.csv — MVA Fund benefit claims 2020–2024.
28_claims_by_type_month.csv — Claims by benefit type and month, 2024.
29_claims_per_service_centre.csv — Claims and case coordinators per service centre.
30_repudiated_claims.csv — Repudiated claims by reason, 2024.
31_medical_claims_count.csv — Medical service provider claim counts, 2020–2024.
32_medical_claims_expenses.csv — Medical service provider claim expenses (N$), 2020–2024.
33_registered_vehicles_per_town.csv — Registered vehicle counts per RA town, Nov 2023.

## Suggested use in the platform

- Load region-level tables (04, 12, 16, 21, 25) into a `regional_stats` table keyed
  by region name and year — use as a choropleth overlay layer, separate from your
  point-level crash pins.
- Use 08, 22, 26 (time-of-day patterns) to power a "typical risk window" reference
  on the map UI.
- Use 05/06 to pre-populate a crash-type taxonomy/dropdown consistent with MVA
  Fund's own categories, so extracted news data can be coded the same way.
- Periodically check mvafund.com.na for next year's report to append new columns.
