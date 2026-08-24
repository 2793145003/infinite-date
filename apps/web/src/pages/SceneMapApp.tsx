import { SceneMapViz } from './SceneMapViz';

/**
 * 地图入口 —— 只留图形页（Voronoi 凸块地图），去掉列表页。
 */
export function SceneMapApp({
  onBack,
  onOpenLocation,
  onExplore,
}: {
  onBack: () => void;
  onOpenLocation: (locationId: string) => void;
  onExplore: (locationId: string, locationName: string) => void;
}) {
  return (
    <SceneMapViz
      onBack={onBack}
      onOpenLocation={onOpenLocation}
      onExplore={onExplore}
    />
  );
}
