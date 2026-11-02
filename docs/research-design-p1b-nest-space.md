# 研究與設計 P1-B：蟻巢空間與共用花園幾何

> 這是研究與設計稿，**不修改程式、參數或存檔，也不推進遊戲時鐘**。依 CLAUDE.md §6，實作必須另開 PR，合併後從下一個遊戲日起生效。文獻的逐筆細節（引用、讀取程度、條件、不可外推之處）見 `reports/p1b-nest-space/literature-notes.md`（英文）；示意座標與兩地點間距離範圍的計算見 `reports/p1b-nest-space/geometry-check.py`（只用世界紀錄的方位字與約距離，輸出在同目錄）。依 `docs/requirements-and-plan.md` 屬 Roadmap P1-B（第一部分：共用空間資料；第二部分：巢穴）。
>
> 數值分三類：**文獻支持**、**一般生理學**、**遊戲假設**。若文獻只支持機制方向、數值卻是假設，就分開寫成「機制：文獻支持；數值：遊戲假設」。證據分級沿用 repo 慣例：**a**＝本種，**b**＝其他物種（「非本種」），**c**＝查無資料。
> 新文獻編號為 **R290–R311**（R116 是既有編號，即 Tsuji & Win 2025，已核實存在）。

---

## 0. 結論先講

1. **本種的巢是淺層、貼著覆蓋物的「縫隙＋淺室」複合體，不是深層地下建築。**
   - 本種常在磚塊、水泥板、**花盆**、石塊、倒木下，以及擾動土、草坪、花圃、步道邊緣築巢（R95、R93、R294）。
   - 19 世紀的野外紀錄說巢室寬而扁，約 10×10 至 15×10 cm、「不高」，挖掘深度「不超過一兩吋」（約 2.5–5 cm）。這只是**軼聞層級**的紀錄（R290）。
   - 2026 廣西研究偏好潮濕陰蔽的現成空腔（R94）。
   - 地表常見多個出入口與鬆土堆（R95）。
   - **N00 花盆土丘與上述型態相容**，但幾何量全部仍是 null。
2. **多巢（polydomy）有本種證據**（R116 已核實；R99、R294）。
   - 野外巢常相距約 1 m 內（定性描述）。
   - 實驗室中，巢與巢相連時工蟻與食物可互通；切斷後育幼幾乎停止。
   - 分巢（budding）時，蟻后、工蟻與幼體一起移到新址。
   - 巢間流量、巢距、巢數在本花園都是 **null**。
3. **遷巢與淹水方面，本種只有族群尺度的方向性證據。**
   - 澳洲雨林族群在乾季外擴約 12 m、濕季內縮約 7 m，並集中在排水線一帶（R291）。
   - 個體層級的觸發與速率只有同屬或他屬的證據：
     - 降雨後遷巢增加（R295，非本種）；
     - 降雨無影響、空氣乾燥（VPD）才有影響（R296，非本種）；
     - 巢口碰到水會引發警報奔跑（R297，屬層級，未確認含本種）；
     - 雨後築圍堤（R298，另兩種大頭家蟻）；
     - 淹水後撤離（R299，非本種）。
   - **因此本種的這些開關全部設為 null，預設關閉。**
4. **明文禁止複製**：收穫蟻（*Pogonomyrmex*）的多公尺深巢室串、切葉蟻（*Atta*）的通風塔與巨巢、紅火蟻（*Solenopsis invicta*）的溫控土丘與筏、*Pheidole oxyops* 的 5 m 深巢，以及巨山蟻（*Camponotus*）／蟻屬（*Formica*）的「巢體積對工蟻數」迴歸（R77、R71、R75、R76、R303、R304、R305、R308、R69、R70）。
5. **共用空間資料的原則：移動距離以引擎現有的 `edge_length_cm` 為唯一權威。** 畫面只能讀取，不能為了好看改長度；位置未知就保持未知，並標明來源。
   - 目前有三份空間紀錄互不一致，這是要請玩家裁示的問題，**不自行修正**（見 §8）：
     - 舊存檔地圖是從 N00 放射出去的星狀圖；
     - 引擎的拓樸沒有 N00–F04／N00–F05 直達邊；
     - 有長度的邊只有 4 條。

---

## 1. 已確認的現況（只讀）

| 項目 | 位置 | 內容 |
|---|---|---|
| 舊敘事地圖 | `saves/world-state.json#/world_map` | 原點是 N00 入口，單位 cm，`precision: 敘事近似值非實測`。各地點有方位字與約距離，`coordinates_cm` 全部 null。N01、N02 的方位「未定」，距離 null。 |
| 引擎拓樸 | `world/xitun-garden.json#/routes/topology/edges` | 10 條邊（含 F01–F04、F04–F05、F08–F05、N00–U01） |
| 移動長度 | `#/routes/edge_length_cm` | 只有 F01:N00=48、F07:N00=31、F08:N00=83、F11:N00=35；`path_tortuosity`=1；其餘邊用 `route_edge_minutes`=25 |
| 引擎用法 | `engine/activity.ts#edgeMinutes` | 有長度時，分鐘數＝長度×10×曲折度÷速度÷60；沒有長度時用舊的 25 分鐘 |
| 畫面用法 | web-mvp 分支 `cli/web-export.ts#layoutOf` | 8 方位字轉角度，x＝sin×距離、y＝cos×距離（示意圖）；沒有方位或距離的地點放進「位置未知」區 |
| 巢 | `docs/nest-construction.md` | N00 有 2 育幼空間、1 儲藏空間、1 泥脊，都是 `legacy_story_known_qualitative`；容積、深度、入口數全部 null |
| 巢溫 | `world.nest_microclimate` | `nest_buffer_fraction`=0.55、`nest_temp_memory`=0.6（遊戲假設） |

**示意座標的一致性下限**（`scripts/geom.py` 算出；方位字只精確到 ±22.5°）：

| 邊 | 引擎長度 | 示意直線 | ±22.5° 時的直線範圍 |
|---|---|---:|---:|
| F01–F04 | 未知 | 67.3 cm | 44.0–103.0 cm（三角不等式下限 ≥44 cm） |
| F04–F05 | 未知 | 152.6 cm | 118.4–165.0 cm |
| F08–F05 | 未知 | 156.0 cm | 144.7–156.0 cm |

這些範圍是**驗證器的約束，不是長度**，不得寫入 `edge_length_cm`。

---

## 2. 共用花園空間資料模型（引擎與畫面共用一份幾何）

### 2.1 基本原則
1. **一份檔案、兩種讀者**：建議新增 `world/<world_id>.geometry.json`（schema `antempire.world-geometry.v1`）。引擎與 `cli/web-export.ts` 都只讀它；`web/` 只讀匯出結果，不寫回（CLAUDE.md §8）。
2. **移動用長度只有一個來源**：`edges[].length_cm` 的值必須與現行 `world/xitun-garden.json#/routes/edge_length_cm` **逐值相同**，並附 `source_ref` 指向原欄位。第一個 PR 不搬移欄位，只做雙向一致性檢查。
3. **畫面用的折線不是移動距離**：`display_polyline` 一律標 `display_only: true`。
   - 若該邊有 `length_cm`，折線的幾何長度必須等於 `length_cm × path_tortuosity`（允許誤差由驗證器定，建議 ≤0.5 cm），否則驗證失敗。
   - 若該邊沒有長度，折線只能畫成虛線「示意」，標籤寫「長度未知（引擎沿用 25 分鐘）」，**引擎絕不讀它**。
4. **未知保持未知**：位置只能是 `unknown`、`schematic_from_bearing`（由方位字＋約距離推出的示意）、`scenario_declared`（玩家宣告的情境假設）或 `measured`（目前沒有任何一筆）。不得為了排版把未知地點放進地圖。
5. **敘事約距離是地點屬性，不是邊長**：`sites[].legacy_straight_line_from_origin_cm` 保存 92、73 等值，用途只是畫示意圖與驗證三角不等式。
6. **世界與蟻群分離**（CLAUDE.md §2.2）：
   - 幾何檔只放**世界的靜態特徵**，例如覆蓋物、既有縫隙、表面類型、遮蔭與排水的介面、以及巢址候選。
   - 蟻群挖出的空間、各巢室的占用與內容，存在存檔的 `nest_state`（動態，見 §3）。後者以 ID 參照幾何檔。
   - 世界物理（雨水入滲、表土濕度）可以讀幾何，**不得讀蟻群的需求或人口**。

### 2.2 座標系
| 欄位 | 值 | 說明 |
|---|---|---|
| `origin` | N00 現任入口（E-N00-1）的地表點 | 與舊存檔「N00入口 (0,0)」相同 |
| `units` | cm | 距離與座標；巢內尺寸可用 mm，但欄位名稱要帶 `_mm` |
| `axes` | x＝東，y＝北，z＝上 | z=0 是原點處地表；地下為負值 |
| `north_reference` | `true_north_assumed` | 情境假設，待玩家確認（§8 Q4） |
| `real_world_anchor` | 行政區「臺中市西屯區」；`fictional: true`；`address: null`；`lat_lon: null` | 別墅是虛構的，沒有門牌，也沒有測量 |
| `latitude_deg_for_solar_geometry` | null（若日後啟用日照介面，可由情境宣告約 24.18°N） | 地理概略值，屬情境假設 |
| `climate_reference` | R310 中央氣象署臺中站（位於北區精武路，不在西屯） | 實測統計作為先驗，`assumption: true` |

### 2.3 來源標籤（provenance）列舉
- `narrative_legacy`：取自 Day1–14 敘事。原檔唯讀，這裡只複製，並附 `legacy_ref` JSON pointer。
- `scenario_assumption`：玩家或情境宣告的遊戲假設。
- `derived_display`：由其他欄位計算、只供顯示（例如由方位字推出的示意座標）。
- `literature_prior`：文獻先驗，必附 R 編號與外推限制。
- `real_world_reference`：真實地理或氣候資料，例如 CWA。
- `measured`：實測。**本花園目前沒有任何一筆**；保留此值是為了誠實區分。

每個數值欄位沿用 repo 慣例 `{value, assumption, basis, ...}`。未知時 `value: null`，並寫 `unknown_reason`。

### 2.4 圖層
| 圖層 | 主要欄位 | 備註 |
|---|---|---|
| `frame` | 見 §2.2 | 全檔一份 |
| `sites[]` | `id`、`kind`（nest_site／food_site／unexplored／abandoned_nest）、`legacy_bearing_word`、`legacy_straight_line_from_origin_cm`、`position{x_cm,y_cm,z_cm}｜null`、`position_status`、`position_uncertainty{bearing_sector_deg:45, distance_tolerance_cm:null}`、`provenance` | N01／N02／U00／U01 的位置是 `unknown` |
| `edges[]` | `id`（排序後以「:」連接，與 `edgeKey` 相同）、`from`、`to`、`length_cm`（有就附 `source_ref`）、`length_status`（recorded／unknown）、`substrate_ref`（表面 ID 或 null）、`display_polyline`、`display_only:true`、`legacy_edge_ref` | 拓樸與引擎 `routes.topology.edges` 逐條相同；舊星狀邊另列在 `legacy_story_edges[]`，**引擎不讀** |
| `surfaces[]` | `id`、`surface_type`（bare_soil／potting_soil／lawn／leaf_litter／paver／stone／wall／concrete／wood_debris／root_zone／pot_wall）、`polygon｜null`、`texture｜null`、`provenance` | 本種偏好的類型：擾動土、草坪、步道邊緣、覆蓋物下、根際、落葉（R95、R292、R294） |
| `obstacles[]` | `id`、`kind`（wall／pot／paver_edge／water_channel）、`geometry｜null`、`ant_passable｜null`、`climbable｜null` | 也用來回答「為什麼 F05 沒有直達邊」這類問題，但**只在玩家宣告後**才填 |
| `microsites[]` | `id`、`area_ref`、`shade_fraction_by_hour｜null`、`insolation_index｜null`、`canopy_cover｜null`、`drainage_class｜null`（free／moderate／impeded／ponding）、`ponding_threshold_mm_per_h｜null`、`relative_elevation_cm｜null`、`irrigation_exposure｜null`、`soil_moisture_index_ref` | **介面先定好，值一律 null**，直到情境宣告。現有 `climate.soil_*`、`soil_shade_*` 指標屬全園層級，可作為預設的 `soil_moisture_index_ref` |
| `cover_objects[]` | `id`、`kind`（flower_pot／stone／paver／brick／log／slab）、`footprint｜null`、`thickness_mm｜null`、`material`、`movable_by_human｜null` | 本種在覆蓋物下築巢（R95、R290）。N00 的覆蓋物是倒置花盆 |
| `nest_site_templates[]` | `id`、`site_ref`、`cover_object_ref`、`pre_existing_voids[]`（`void_id`、`kind`：object_soil_gap／crack／wood_cavity／pot_drain_hole／litter_pocket；`footprint_cm2｜null`；`height_mm｜null`；`depth_below_surface_mm｜null`）、`entrance_candidates[]`（`id`、`position｜null`、`relative_elevation_mm｜null`）、`provenance` | 屬世界的既有空腔，不代表已被占用 |
| `legacy_story_edges[]` | 舊星狀邊（含 92、73 等），`engine_reads:false` | 歷史對照 |

### 2.5 現有「方位＋約距離」如何對應
1. 對每個 `world_map.locations[]` 建一筆 `sites[]`：
   - `legacy_bearing_word`、`legacy_straight_line_from_origin_cm` 原樣複製；
   - `legacy_ref` 指向原 pointer。
2. 方位字屬於 8 個方位之一，且距離是數字時：
   - 寫入 `position_status: schematic_from_bearing`、`provenance: derived_display`；
   - 座標用與 `layoutOf` 完全相同的公式，畫面結果不變；
   - `position_uncertainty.bearing_sector_deg = 45`。
3. 方位為「未定」「未知」或距離為 null 時：`position: null`、`position_status: unknown`，畫面繼續放在「位置未知」區。
4. **示意座標只用於顯示與驗證，不得反推任何引擎長度。**
5. 若玩家日後宣告實際配置圖：
   - 改為 `scenario_declared`，並升 `geometry_version`；
   - 若同時改變任何 `length_cm`，就是**規則更新 PR**，從下一日起生效。

### 2.6 驗證器（`npm run check:geometry`，建議新增）
- **V1**：`edges` 的集合與 `routes.topology.edges` 完全相同（無向、排序後比較）。
- **V2**：凡 `length_status=recorded`，`length_cm` 必須等於 `edge_length_cm[id]`；凡 `edge_length_cm` 有值，對應的邊不得是 unknown。
- **V3**：有長度的邊，其 `display_polyline` 長度必須等於 length×tortuosity（誤差 ≤0.5 cm），否則失敗；無長度的邊，其折線必須 `display_only` 且 `style: schematic`。
- **V4**：地點位置的狀態必須與來源一致：`unknown` 的地點 position 為 null；`schematic_from_bearing` 的座標必須能由方位與距離重算出來。
- **V5（警告，不失敗）**：對有兩端示意位置的邊，若日後填入的長度小於 ±22.5° 範圍內的最短直線（例如 F01–F04 <44 cm），就發出警告，請玩家確認。
- **V6**：幾何檔的每個數值都有 `assumption` 與 `basis`；`measured` 必須附量測紀錄 ID。
- **V7**：**引擎的生態與天氣模組不得 import `nest_state`**。用靜態 import 檢查實現，對應 CLAUDE.md §2.2。

### 2.7 版本
- 檔頭有 `schema`、`geometry_version`（semver）、`effective_from_day`、`changelog[]`、`supersedes`。
- **整份檔案都納入規則指紋**（`cli/lib/fingerprint.ts`）。從嚴認定：任何修改都視為規則更新，另開 PR，下一日起生效。
- 若玩家希望改顯示用折線時不觸發規則更新，可以另議把 `display_*` 欄位拆到 `web/` 的唯讀附檔，但預設採從嚴做法。
- 推進遊戲日時禁止修改（CLAUDE.md §5）。Day1–14 的 `world_map` 維持唯讀，幾何檔只引用、不回寫。

### 2.8 範例 JSON（精簡）
```json
{
  "schema": "antempire.world-geometry.v1",
  "world_id": "xitun-garden",
  "geometry_version": "1.0.0",
  "effective_from_day": null,
  "frame": {
    "origin": "E-N00-1 地表點（舊存檔「N00入口」）",
    "units": "cm",
    "axes": { "x": "east", "y": "north", "z": "up" },
    "north_reference": { "value": "true_north_assumed", "assumption": true, "basis": "遊戲假設" },
    "real_world_anchor": { "admin_area": "臺中市西屯區", "fictional": true, "address": null, "lat_lon": null },
    "climate_reference": { "ref": "R310", "station": "中央氣象署臺中站（北區）", "assumption": true, "basis": "文獻支持", "basis_note": "1991–2020 平年值作為先驗，不是本花園實測" }
  },
  "sites": [
    { "id": "N00", "kind": "nest_site", "legacy_bearing_word": "中心", "legacy_straight_line_from_origin_cm": 0,
      "position": { "x_cm": 0, "y_cm": 0, "z_cm": 0 }, "position_status": "scenario_declared",
      "provenance": "narrative_legacy", "legacy_ref": "saves/world-state.json#/world_map/locations/0" },
    { "id": "F04", "kind": "food_site", "legacy_bearing_word": "北", "legacy_straight_line_from_origin_cm": 92,
      "position": { "x_cm": 0, "y_cm": 92, "z_cm": null }, "position_status": "schematic_from_bearing",
      "position_uncertainty": { "bearing_sector_deg": 45, "distance_tolerance_cm": null },
      "provenance": "derived_display", "legacy_ref": "saves/world-state.json#/world_map/locations/6" },
    { "id": "N01", "kind": "abandoned_nest", "legacy_bearing_word": "未定", "legacy_straight_line_from_origin_cm": null,
      "position": null, "position_status": "unknown", "provenance": "narrative_legacy" }
  ],
  "edges": [
    { "id": "F01:N00", "from": "N00", "to": "F01", "length_status": "recorded",
      "length_cm": { "value": 48, "assumption": true, "basis": "遊戲假設", "source_ref": "world/xitun-garden.json#/routes/edge_length_cm/F01:N00" },
      "display_polyline": [[0, 0], [33.94, 33.94]], "display_only": true },
    { "id": "F01:F04", "from": "F01", "to": "F04", "length_status": "unknown", "length_cm": null,
      "unknown_reason": "世界設定沒有記錄此路段長度；引擎沿用 route_edge_minutes",
      "consistency_hint": { "min_straight_line_cm_if_bearings_hold": 44.0, "basis": "derived_display" },
      "display_polyline": [[33.94, 33.94], [0, 92]], "display_only": true, "style": "schematic" }
  ],
  "cover_objects": [
    { "id": "CO-N00-POT", "kind": "flower_pot", "note": "倒置花盆（敘事）", "footprint": null, "thickness_mm": null,
      "movable_by_human": null, "provenance": "narrative_legacy" }
  ],
  "microsites": [
    { "id": "MS-N00", "area_ref": "N00", "shade_fraction_by_hour": null, "insolation_index": null,
      "drainage_class": null, "ponding_threshold_mm_per_h": null, "relative_elevation_cm": null,
      "soil_moisture_index_ref": "climate.soil_shade_*（全園指標）", "provenance": "scenario_assumption" }
  ],
  "nest_site_templates": [
    { "id": "NT-N00", "site_ref": "N00", "cover_object_ref": "CO-N00-POT",
      "pre_existing_voids": [ { "void_id": "V-N00-a", "kind": "object_soil_gap", "footprint_cm2": null, "height_mm": null, "depth_below_surface_mm": null } ],
      "entrance_candidates": [ { "id": "E-N00-1", "position": { "x_cm": 0, "y_cm": 0, "z_cm": 0 }, "relative_elevation_mm": null } ],
      "provenance": "narrative_legacy" }
  ],
  "legacy_story_edges": [
    { "from": "N00", "to": "F04", "legacy_approx_distance_cm": 92, "engine_reads": false,
      "legacy_ref": "saves/world-state.json#/world_map/route_edges/3" }
  ]
}
```

---

## 3. ODD 子模型：蟻巢空間、環境耦合、建造／修補、遷巢

### 3.1 目的與型態
目的是讓**巢內空間、巢室微氣候、淹水與遷巢**成為局部、可重播、守恆的過程。依據是本種的「淺層覆蓋物下縫隙巢＋多巢」型態，同時不給任何個體全巢資訊。

### 3.2 實體、狀態變數與尺度
| 實體 | 狀態變數（未知為 null） | 存放位置 |
|---|---|---|
| `Nest`（巢） | `id`、`colony_id`、`site_ref`、`template_ref`、`status`（occupied／abandoned／candidate_known_by[]）、`founded_day`、`abandoned_day` | 存檔 `colonies[].nests[]` |
| `Cavity`（巢室或縫隙） | `id`、`origin`（pre_existing_void／excavated）、`footprint_cm2`、`height_mm`、`depth_below_surface_mm`、`void_volume_mm3`、`wall_material`（soil／carton_fibre_earth／object_surface）、`wetness_state`（dry／damp／wet／flooded：模型狀態，不是量測）、`temp_model_c`、`occupants{workers[], brood[], queen?, stores}`、`loose_soil_mg`、`debris_mg` | 存檔 `nest_state.cavities[]` |
| `Passage`（巢內通道） | `id`、`a`、`b`、`length_mm｜null`、`width_mm｜null`、`collapsed:boolean` | 存檔 |
| `Entrance`（出入口） | `id`、`cavity_ref`、`surface_point_ref`、`open:boolean`、`relative_elevation_mm｜null`、`spoil_pile_mg｜null`、`levee_height_mm｜null`（本種沒有證據，保持 null，預設不築） | 存檔 |
| `Worker`（新增欄位） | `location` 擴充為「巢 ID／巢室 ID」或「路網節點」，另有 `carrying{kind: brood／pellet／food／none, id?}` | 存檔 |

- **時間**：沿用 v17 的逐分鐘個體時間軸。巢內移動與工作是同一時間軸上的片段；日尺度只做世界物理的結算。
- **空間**：巢內是**節點圖**（巢室＋通道），不做連續三維。挖掘形態由局部擁擠產生（R306），不預設形狀。

### 3.3 過程概覽與排程（每日；插入現行 `gm-rules.md` 順序，位置待規則更新 PR 確定）
1. **世界物理（與蟻群無關）**：
   - 天氣 → 微地點地表水與土壤濕度指標；
   - 依幾何算出巢室的濕度狀態：只讀巢室幾何、所屬微地點與入口高程，**不讀蟻群人口或需求**；
   - 巢室溫度用現行 `nest_buffer_fraction` 模型。若規則更新啟用深度衰減，才改成下式（R309）：
     `T_cav = T_mean + (T_surface − T_mean)·exp(−depth/D)`
     其中 `D` 為 null；啟用時必須由情境宣告，並標為遊戲假設。
2. **局部事件產生**：巢室變成 wet 或 flooded、通道坍塌、入口被沖毀。這些是世界事件，各有事件 ID。
3. **個體在時間軸上行動**（v17）：巢內工蟻只感知**自己所在的巢室**，包括：
   - 地面濕或積水（身體接觸）；
   - 擁擠程度（同室個體數 ÷ 巢室面積；面積為 null 時只用同室個體數的相對變化）；
   - 幼蟲求食訊號（實際接觸的幼體）；
   - 鬆土與垃圾；
   - 同伴的警報（若物種開關啟用）。
4. **任務選擇**：沿用現有的局部訊號框架，新增 `excavate`、`carry_pellet`、`repair_entrance`、`move_brood`、`scout_nest_site`、`emigrate_carry`，與覓食、育幼競爭同一段時間。
5. **日終結算與守恆檢查**（見 §5）。

### 3.4 設計概念
- **無上帝視角**：
  - 工蟻不知道其他巢室是否淹水，除非走進該室，或碰到從那裡逃出來、帶著警報的同伴（後者須物種開關啟用）；
  - 沒有全巢「洪水警報」；
  - 蟻后不下指令。
- **刺激只能來自局部**：搬幼體的前提是搬運者在該室親身感知到濕或擠，而且知道另一間可達且較乾的巢室（親自走過）。這與 R72、R297、R299 的機制方向一致。
- **隨機性**：使用各蟻群自己的 rng namespace，與世界種子分離；不得重跑擇優。
- **可以失敗**：
  - 搬運途中可能掉落或中斷；
  - 遷巢可能中途放棄（R295）；
  - 修補可能因土太乾、太濕而無法進行（R305、R71）。

### 3.5 初始化
- **N00**：依 `nest-construction.md` 建 1 個巢、3 個巢室（育幼 A、育幼 B、儲藏 C）與至少 1 個入口 E-N00-1。
  - 所有幾何量 null，`origin: pre_existing_void`（與花盆下縫隙的敘事相容），`wall_material: null`；
  - 泥脊記為 `legacy_story_structure`，**不轉換成具防洪效果的圍堤參數**。
- **Day0 創巢情境**：只能由情境檔宣告初始巢室數量。建議預設 1 個 `object_soil_gap` 巢室加 1 個入口；幾何 null，標遊戲假設。
- **N01、N02**：`abandoned`，`candidate_known_by: []`。歷史個體的路線記憶沒有它們，所以不能自動成為遷巢候選。

### 3.6 輸入
- 天氣：現行引擎。
- 幾何：§2 的檔案。
- 物種參數：`species/pheidole-megacephala.json` 新增的 `nest` 區塊，見 §4。
- 情境宣告：微地點的遮蔭與排水、覆蓋物尺寸。

### 3.7 子模型

#### A. 巢空間：巢室、出入口與巢內移動
- **巢室容量**：`capacity_workers = footprint_cm2 × density_cap_per_cm2`，兩者皆 null。
  - 為 null 時**不施加容量限制**，只輸出 `crowding_cue = 同室個體數 / 同室個體數的滑動中位數`（遊戲假設），作為局部擁擠訊號；
  - 不得用工蟻數反推巢體積（R69／R70 是他種，禁止）。
- **巢內移動**：通道有長度時，時間＝長度÷巢內速度；兩者皆 null 時，使用 `in_nest_move_minutes`（遊戲假設，值待定）。巢內速度**不得**套用地表的 `trail_walking_speed_mm_s`。
- **出入口**：
  - 工蟻出入只經 `open:true` 的入口；
  - 入口數依本種「多入口」的描述（R95）可以大於 1，但 N00 目前只確認 1 個，多的不憑空產生；
  - 新入口只能由挖掘事件產生。
- **深度約束**：`max_cavity_depth_mm` 為 null，代表模型**不產生深於既有巢室的新室**，除非情境或規則宣告上限。
  - R290 的 2.5–5 cm 只作 pattern 驗證的參考（§5），不作參數。

#### B. 環境耦合：溫度、濕度、排水與風險
- **溫度**：
  - 第一階段沿用 `nest_buffer_fraction`／`nest_temp_memory`，不改；
  - 第二階段（另開規則更新）才加深度與覆蓋物衰減，以 R309 的機制為準，`soil_thermal_diffusivity`、`cover_object_heat_capacity` 均為 null，必須由情境宣告；
  - 淺巢（R290）表示巢溫接近表土溫度，這是 pattern 驗證的方向，不是數值。
- **濕度**：巢室只有離散的 `wetness_state`，**不輸出 RH%**，因為沒有測量。狀態轉移由下列量決定：
  - 微地點土壤濕度指標；
  - `drainage_class`；
  - 入口相對高程；
  - 巢室深度。
  在情境宣告這些值之前，轉移機率全部 null。null 時模型退回現狀：沒有巢室濕度事件，並在日誌註明「巢內水分未知」，與現行敘事一致。
- **排水與淹水**：當日降雨強度超過 `ponding_threshold_mm_per_h` 且入口相對高程 ≤ 0 時，標記入口 `flooded`，並沿通道向下影響巢室。全部是世界事件，各附來源事件 ID。
- **風險**：
  - 淹水巢室中的卵、幼蟲、蛹與成蟲，死亡機率皆為 null；
  - 啟用前必須另開規則更新並附多種子、極端情境的證據；
  - 高溫加乾燥會提高本種死亡率（R146），**只在數值有根據後啟用**，預設關閉。
  - 空氣乾燥可能促成遷巢（R296，非本種），也只在數值有根據後啟用，預設關閉。

#### C. 建造與修補
- **挖掘是離散的搬土粒事件**（R305 機制，非本種）：
  1. 工蟻在所在巢室的壁面取得一粒土；
  2. 沿通道走到入口；
  3. 把土堆在入口外的 `spoil_pile`。鬆土堆是本種常見的地表痕跡（R95）。
  - 每粒土的質量 `pellet_mass_mg` 為 null。null 時只計**粒數**，不計質量與體積；巢室體積變化保持 null，也不宣告「完工百分比」。
- **挖掘的土壤濕度窗口**：`excavation_moisture_window` 為 null。機制方向（太乾、太濕都不挖）是「機制：文獻支持（非本種 R305、R71）；數值：遊戲假設」。
- **觸發**：只能來自所在巢室的局部擁擠、鬆土、坍塌，或幼體剛被搬入（R72 方向）。不是每日自動成長。
- **修補**：通道坍塌或入口沖毀之後，由在場工蟻清出土粒、重新打通，使用同樣的搬土粒事件。
- **紙板狀巢壁**：本種在石下的巢室壁曾見木纖維混土（R290），所以 `wall_material` 有 `carton_fibre_earth` 選項。建造它的速率與材料來源是 null，**預設不模擬建造**。
- **圍堤**：`entrance_levee_building` 為 null，預設關閉。另兩種大頭家蟻會築（R298），但本種沒有證據。
- **守恆**：`removed_pellets = in_nest_redeposit + spoil_pile + spill`，以粒數計。

#### D. 遷巢、分巢與多巢
- **候選巢址**：只能是某隻工蟻親身走到、並在該處接觸過空腔的 `nest_site_template` 或舊巢。舊巢在個體記憶中標為候選，因為同屬兩種常回到舊巢（R295，非本種）。
- **觸發**：所在巢室為 `flooded`／`wet` 且持續、通道或入口坍塌、或人為擾動事件（例如花盆被移動，須由情境的人類活動模組產生，與蟻群無關）。
  - 所有觸發機率為 null，預設不發生；
  - 降雨對遷巢的方向在屬內互相矛盾（R295 與 R296），不可固定成正向。
- **程序**：
  1. 偵察工蟻抵達候選巢址；
  2. 回到原巢的局部招募，機制沿用現有的 local recruitment；本種的遷巢招募訊號未知，強度 null；
  3. 工蟻一次搬一個幼體或一份存糧，搬運需走完路段時間；
  4. 蟻后**自行步行**，由在場工蟻伴隨（R295，非本種，作為機制）；
  5. 可能中途放棄，或停在兩巢並存。
- **多巢**：遷巢若沒有完成，就形成同一蟻群的兩個巢。本種本來就是多巢（R116），所以兩巢並存是合法狀態。
  - 巢間交換依 `research-design-2026-11.md` §1.3：工蟻把姊妹巢當成「地點」；
  - 食物只在有實體路段相連時流動（R116 實驗、R157 方向）。
- **族群尺度**：R291 的「濕季內縮、乾季外擴」只作長期 pattern 驗證，不作個體規則。
- **禁止**：瞬移、整巢一步搬完、複製蟻后、不經路段就出現新巢、紅火蟻式的筏。

---

## 4. 參數表（`species/pheidole-megacephala.json` 的 `nest` 區塊與世界幾何；未知一律 null）

| 參數 | 值 | assumption | basis | 依據／說明 |
|---|---|---|---|---|
| `nest.typical_form` | `"shallow_cover_object_cavity_complex"`（類別，非數值） | true | 文獻支持 | R95、R290、R94；屬定性分類 |
| `nest.max_cavity_depth_mm` | null | true | — | R290 為軼聞 2.5–5 cm，只供 pattern 驗證 |
| `nest.chamber_footprint_cm2_range` | null | true | — | R290 約 100–150 cm²，軼聞，不作參數 |
| `nest.entrances_per_nest` | null | true | — | R95「多入口」為定性描述 |
| `nest.worker_density_cap_per_cm2` | null | true | — | 查無 |
| `nest.in_nest_move_minutes` | null（待規則更新 PR 設定為遊戲假設） | true | 遊戲假設 | 查無本種巢內速度 |
| `nest.pellet_mass_mg` | null | true | — | R305 為紅火蟻，禁止套用 |
| `nest.excavation_moisture_window` | null | true | 機制：文獻支持（非本種）；數值：— | R305、R71 |
| `nest.carton_wall_construction_enabled` | null | true | — | R290 有觀察，但沒有速率 |
| `nest.entrance_levee_building` | null（預設關閉） | true | — | R298 為其他大頭家蟻 |
| `nest.flood_alarm_runs` | null（預設關閉） | true | — | R297 未確認含本種 |
| `nest.emigration_trigger_wet_probability` | null | true | — | R295、R296 方向互相矛盾 |
| `nest.emigration_trigger_vpd` | null | true | — | R296 非本種 |
| `nest.queen_walks_during_emigration` | true（機制開關） | true | 機制：文獻支持（非本種 R295）；開關：遊戲假設 | 避免「搬運蟻后」的未證實行為 |
| `nest.return_to_former_nest_bias` | null | true | — | R295 的 42–49% 是非本種數值，禁止套用 |
| `nest.polydomy_enabled` | true（能力開關） | true | 文獻支持 | R116、R99；開關不代表會發生 |
| `nest.inter_nest_spacing_cm` | null | true | — | R116 野外「常在約 1 m 內」為定性描述 |
| `nest.flood_mortality_per_stage` | null | true | — | 查無 |
| `nest.heat_dry_mortality_modifier` | null | true | 機制：文獻支持（R146）；數值：— | 摘要層級 |
| `world.microsite.shade_fraction_by_hour` | null | true | — | 介面，等情境宣告 |
| `world.microsite.drainage_class` | null | true | — | 同上 |
| `world.microsite.ponding_threshold_mm_per_h` | null | true | — | 同上 |
| `world.soil_thermal_diffusivity_mm2_s` | null | true | 機制：一般物理（R309）；數值：— | 土質未知 |
| `world.cover_object_heat_capacity` | null | true | — | 同上 |
| `world.latitude_deg_for_solar_geometry` | null（情境可宣告約 24.18°N） | true | 遊戲假設 | 虛構地址；R310 只作氣候先驗 |
| 既有 `nest_buffer_fraction` | 0.55（不變） | true | 遊戲假設 | 現行 |
| 既有 `edge_length_cm` | 48／31／83／35（不變） | true | 遊戲假設 | 唯一移動長度來源 |

---

## 5. 驗證模式（pattern-oriented；只是診斷，不是調參目標，CLAUDE.md §7）

| 編號 | 檢查 | 預期 | 依據 |
|---|---|---|---|
| P1 | 引入幾何檔但引擎不讀 | `tests/golden.test.ts` 逐位元組相同 | CLAUDE.md §6、§9 |
| P2 | 引擎改從幾何檔讀 `length_cm` | 逐位元組相同（純重構） | 同上 |
| P3 | 畫面位置 | 有示意座標的地點與 web-mvp 的 `layoutOf` 結果相同；未知地點仍在「位置未知」區 | §2.5 |
| P4 | 巢深 | 沒有情境宣告時，不產生比既有巢室更深的巢室；任何巢室深度 >（情境上限）就判定失敗 | R290、R303、R304 |
| P5 | 守恆 | 個體（工蟻、幼體、蟻后）在巢室、通道、路網之間不重複、不消失；土粒守恆；存糧在巢間移動時總量守恆 | gm-rules |
| P6 | 局部性 | 單元測試：把某巢室設為 flooded 時，不在該室、也沒碰到逃出者的工蟻，任務選擇與對照組相同 | CLAUDE.md §2.1 |
| P7 | 世界獨立 | 靜態檢查：生態與天氣模組不 import `nest_state` 或 `colony`；兩群人口不同但世界種子相同時，巢室濕度事件序列相同 | CLAUDE.md §2.2 |
| P8 | 遷巢可行性 | 沒有偵察到的候選巢址就沒有遷巢；遷巢事件鏈必須依序為偵察 → 招募 → 搬運 → 抵達；蟻后的步行有路段時間 | §3.7 D |
| P9 | 極端情境（多種子，保留失敗證據） | 連續 7 日大雨、30 日乾旱、無候選巢址、花盆被移動（情境事件）、入口全部坍塌 | CLAUDE.md §6 |
| P10 | 長期定性 pattern（只記錄，不調參） | 是否出現多巢並存；淹水後幼體是否被搬往較乾的巢室；巢溫是否接近表土溫度 | R116、R299、R309 |

---

## 6. 建議的 PR 順序（每一步各開一個 PR，CLAUDE.md §0）

1. **PR-1｜文獻與研究文件（docs only）**
   - 把本文與 R290–R311 加入 `docs/references.md`；
   - 補 R116 的作者與 DOI；
   - 新增 `docs/nest-space-geometry.md`；
   - 不推進遊戲日，也不改程式。
2. **PR-2｜共用空間資料（資料＋驗證器，不改行為）**
   - 新增 `world/xitun-garden.geometry.json`、`cli/check-geometry.ts` 與測試（V1–V7）；
   - 引擎不讀新檔，golden 不變；
   - 規則指紋是否納入新檔要請玩家決定。建議納入，因此仍標為「規則更新（行為不變）」。
3. **PR-3｜畫面讀取幾何檔（web 只讀）**
   - `cli/web-export.ts` 改為由幾何檔取位置與折線；
   - 截圖對照：P3 必須相同；
   - 不寫 `saves/`、`journal/`。
4. **PR-4｜引擎改從幾何檔讀長度（純重構）**
   - golden 逐位元組相同（P2）；
   - 若不同，就改列為規則更新。
5. **PR-5｜巢空間模型（規則更新）**
   - 新增 `nest_state`、巢室、通道、入口與局部感知；
   - 所有新開關預設關閉、數值 null；
   - 多日、多種子與極端情境測試，保留失敗證據；
   - 存檔格式遷移另附映射與測試；
   - 從合併後的下一日起生效。
6. **PR-6 以後｜各子機制分開**：挖掘與修補、淹水事件、遷巢與多巢。每個都必須先有玩家核可的數值，或明確的遊戲假設與檢驗。

---

## 7. 新增文獻編號（R290–R311）

| ID | 文獻 | 物種／分級 | 讀取 | 用途 |
|---|---|---|---|---|
| R290 | Forel 1893, *Trans. Ent. Soc. London* 1893:333–418（H. H. Smith 野外筆記，pp. 417–418），Zenodo DOI 10.5281/zenodo.6293000 | 本種 a（軼聞） | 全文摘錄 | 淺巢、扁平巢室、紙板狀巢壁、分支巢 |
| R291 | Hoffmann, Andersen & Hill 1999, *Oecologia* 120:595–604, DOI 10.1007/PL00008824 | 本種 a | 摘要 | 排水線、遮蔽微地點、季節性擴縮 |
| R292 | Milligan et al. 2022, *J. Ecology* 110:359–373, DOI 10.1111/1365-2745.13803 | 本種 a | 摘要 | 根際築巢 |
| R293 | Wetterer 2002, *Pacific Science* 56:125–135, DOI 10.1353/psc.2002.0019 | 本種 a | 搜尋摘錄 | 石下、倒木下 |
| R294 | Jackson 2023，Pacific Pests, Pathogens, Weeds & Pesticides，Bigheaded ant (361) | 本種 a（灰色文獻） | 全文 | 落葉、樹皮巢；分巢 |
| R295 | Droual & Topoff 1981, *Psyche* 88:135–150, DOI 10.1155/1981/43265 | *P. hyatti*／*P. desertorum*（b） | 全文 | 遷巢頻率、回舊巢、雨後遷巢、蟻后步行 |
| R296 | Moyano & Feener 2014, *Insectes Sociaux* 61:71–81, DOI 10.1007/s00040-013-0327-1 | *P. dentata*（b） | 摘要 | VPD 觸發遷巢；雨無影響 |
| R297 | Wilson 1986, *Insectes Sociaux* 33:458–469, DOI 10.1007/BF02223951 | *Pheidole* 屬（b） | 摘要 | 巢口碰水引發警報與撤離 |
| R298 | LeBrun, Moffett & Holway 2011, *Insectes Sociaux* 58:263–269, DOI 10.1007/s00040-011-0151-4 | 含兩種大頭家蟻（b） | 全文 | 雨後築圍堤 |
| R299 | Kolay & Annagiri 2015, *Sci. Rep.* 5:13716, DOI 10.1038/srep13716 | *Diacamma indicum*（b） | 全文 | 入口高程、雨後修入口、淹水撤離 |
| R300 | McGlynn 2012, *Annu. Rev. Entomol.* 57:291–308, DOI 10.1146/annurev-ento-120710-100708 | 綜述（b） | 摘要 | 遷巢原因分類 |
| R301 | Debout et al. 2007, *Biol. J. Linn. Soc.* 90:319–348, DOI 10.1111/j.1095-8312.2007.00728.x | 綜述 | 僅書目 | 多巢定義 |
| R302 | Robinson 2014, *Curr. Opin. Insect Sci.* 5:37–43, DOI 10.1016/j.cois.2014.09.002 | 綜述 | 僅書目 | 多巢定義 |
| R303 | Forti et al. 2007, *Insect Science* 14:437–442, DOI 10.1111/j.1744-7917.2007.00171.x | *P. oxyops*（b） | 搜尋摘錄（數字需再核） | **反例：深約 5 m，禁止套用** |
| R304 | Tschinkel 2015, *J. Bioeconomics* 17:271–291, DOI 10.1007/s10818-015-9203-6 | 綜述（b） | 僅書目 | **禁止套用的地下巢清單** |
| R305 | Monaenkova et al. 2015, *J. Exp. Biol.* 218:1295–1305, DOI 10.1242/jeb.113795 | *S. invicta*（b） | 摘要 | 濕度窗口、固定大小的土粒 |
| R306 | Toffin et al. 2009, *PNAS* 106:18616–18620, DOI 10.1073/pnas.0902685106 | *Messor sancta*（b） | 摘要 | 巢形由擁擠產生 |
| R307 | Buhl et al. 2005, *Behav. Ecol. Sociobiol.* 58:9–17, DOI 10.1007/s00265-004-0906-2 | *Messor*（b） | 僅書目 | 自組織挖掘 |
| R308 | Mlot, Tovey & Hu 2011, *PNAS* 108:7669–7673, DOI 10.1073/pnas.1016658108 | *S. invicta*（b） | 僅書目 | **禁止：筏** |
| R309 | Campbell & Norman 1998, *An Introduction to Environmental Biophysics*（Springer），DOI 10.1007/978-1-4612-1626-1 | 一般土壤物理 | 教科書 | 溫度隨深度衰減 |
| R310 | 中央氣象署臺中氣象站頁（stn_id=8），1991–2020 平年值：23.3°C、1773.0 mm、113.7 雨日、日照 2043.2 h | 實測統計 | 全文 | 氣候先驗；日照介面 |
| R311 | Lenoir et al. 2025, *Naturae* 2025(4):35–43, DOI 10.5852/naturae2025a4 | 本種 a | 摘要 | 溫帶只見於加溫溫室（覆蓋與保溫的重要性） |

沿用的既有編號：R93、R94、R95、R99、R101／R110／R113、**R116**（Tsuji & Win 2025 *Biology Open* 14:bio061976，已核實）、R137、R140、R146、R153、R154、R157、R158、R69–R78。

---

## 8. 需要玩家裁示（不自行修正）

1. **拓樸不一致**：
   - 舊地圖有 N00–F04（92）、N00–F05（73）、U00–U01；
   - 引擎沒有 N00–F04／F05 直達邊，且是 N00–U01；
   - 依示意下限，引擎中到 F05 的最短路徑 N00→F08→F05 至少約 228 cm，遠大於敘事的 73 cm。
   - 這是刻意的（例如有障礙物），還是要另開規則更新檢討？
2. **敘事距離的意義**：92、73 等值是否確認為「自 N00 入口的直線距離」？若是，幾何檔把它們放在地點屬性，不當作邊長。
3. **N00 的高程**：「高處倒置花盆」的高處是多高？它決定入口相對高程與淹水風險，目前為 null。
4. **方位基準**：方位字以真北解讀，是否同意（屬情境假設）？
5. **規則指紋範圍**：幾何檔是否整份納入規則指紋（建議納入，從嚴）？
6. **多巢的狀態結構**：是否與 `research-design-2026-11.md` §1 的 `nests[]` 一起改存檔格式？兩者都需要存檔遷移。
