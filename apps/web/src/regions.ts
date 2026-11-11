import type { Region } from '@siteline/engine';
import file from '../../../data/regions.json';

/** NASA's nine Artemis candidate regions (2024), as named centres with an approximate size. */
export const REGIONS: Region[] = file.regions;
