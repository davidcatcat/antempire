#!/usr/bin/env python3
"""Read-only report renderer; sim computations are performed by Node engine, never Python."""
from pathlib import Path
import json,csv
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'reports'; P=ROOT/'sim'
params=json.loads((P/'params.json').read_text())
entries=[]
for group,fields in params.items():
    if not isinstance(fields,dict): continue
    for key,field in fields.items():
        if isinstance(field,dict) and 'value' in field:
            assert field['assumption'] is True,(group,key)
            entries.append([group+'.'+key,field['value'],True,field['description'],'; '.join(field.get('reference_for_mechanism_only',[]))])
assert len(entries)==104
with (OUT/'params-complete.csv').open('w',newline='',encoding='utf-8-sig') as f:
    w=csv.writer(f);w.writerow(['參數','假設值','assumption:true','用途/含義','科學機制參考']);w.writerows(entries)
md=['# 《螞蟻帝國》v2 完整遊戲假設參數表','','**所有 104 項均是 `assumption:true`、非科學實測。單位「份」是抽象遊戲單位，不是 mg。**','','| 參數路徑 | 值 | 說明 |','|---|---:|---|']
for key,v,a,description,ref in entries:
    md.append(f'| `{key}` | {v} | {description.replace("|","／")}' + (f'；機制參考 {ref}' if ref else '') + ' |')
(OUT/'params-complete.md').write_text('\n'.join(md)+'\n')
R={x:json.loads((OUT/f'{x}-day15-44.json').read_text()) for x in ['baseline','abundant','forced-starvation']}
base,rich,starve=(R[x]['report'] for x in ['baseline','abundant','forced-starvation'])
rows=R['baseline']['rows']
out=['# 🐜《螞蟻帝國》v2｜Day15–44 30日隔離試跑','','> **尚未提交 GitHub、Day14仍是正式完成日。** 本報表基於GitHub Day14權威存檔的**必要欄位投影**（14活工蟻、Q001、5卵、2幼蟲、來源事件V2D11-E04等）；正式 Day15 必須由 `sim/migrate_day15.cjs` 直接讀取當時GitHub完整兩份存檔進行一次性轉移。投影中的初始庫存、舊幼蟲發育程度、舊工蟻年齡以及未確認食源，都標為遊戲假設。','','## 三組30天結果','','| 結果 | 一般Day14承接 | 全面斷糧極端測試 | 隔離增糧測試（非保證充足） |','|---|---:|---:|---:|']
def tup(metric):return [base['totals'][metric],starve['totals'][metric],rich['totals'][metric]]
for label,key in [('工蟻羽化','eclosions'),('工蟻死亡','worker_deaths'),('卵孵化','hatchings'),('幼蟲化蛹','pupations'),('幼體死亡','brood_deaths'),('新產卵','eggs_laid'),('成功採入次數','food_delivery_events'),('巢內招募次數','recruitments')]:
 a,b,c=tup(key);out.append(f'| {label} | {a} | {b} | {c} |')
out.append(f"| Day44存活工蟻 | {base['last']['workers']} | {starve['last']['workers']} | {rich['last']['workers']} |")
out.append(f"| 最大連續缺糖天數 | {base['max_sugar_gap']} | {starve['max_sugar_gap']} | {rich['max_sugar_gap']} |")
out.append(f"| 最大連續缺蛋白天數 | {base['max_protein_gap']} | {starve['max_protein_gap']} | {rich['max_protein_gap']} |")
out.extend(['',f"一般情境：**Day{base['first_hatch_day']}首次孵化、Day{base['first_pupa_day']}首次化蛹、首次羽化={base['first_eclosion_day'] or '30日內未出現'}、Day{base['first_worker_death_day']}首次工蟻死亡**；Day44剩下{base['last']['workers']}工蟻。**30日羽化驗收未通過，這是要誠實保留的自然結果，不准為了通過而暗中補食物或強制存活。** 此結果不是對真實野外族群的預測。",'','**斷糧及增糧測試是隔離副本的反事實壓力測試，不是AI對正式遊戲的干預，絕不回寫主存檔。** 增糧條件不保證永久食物充裕，仍可能遭遇死亡。','','## Day15～44每一天的族群、庫存與飢餓','','| 日 | 日期 | 工蟻 | 卵 | 幼蟲 | 蛹 | 糖份 | 蛋白份 | 連續缺糖日 | 連續缺蛋白日 |','|---:|---|---:|---:|---:|---:|---:|---:|---:|'])
for r in rows:
 out.append(f"| {r['day']} | {r['date']} | {r['workers']} | {r['eggs']} | {r['larvae']} | {r['pupae']} | {r['sugar']:.2f} | {r['protein']:.2f} | {r['sugar_starvation_days']} | {r['protein_starvation_days']} |")
out.extend(['','## 工程驗收','','- 每個存活工蟻每日指派恰好一項工作；局部接觸能交換已知路線，成功採集能招募跟隨者。','- Day11 F07 死蟲保留原來源 `V2D11-E04`，按照獨立批次減損；不再要求當天產生新屍才可採。','- 同一份糖/蛋白不能重複入庫；每日必須通過「期初+入巢-消耗-產卵-溢出=期末」檢查；同一工蟻/幼體ID不能重複。','- Day15～44逐日重播，連30個日結、純函式不修改輸入，並有不同食物壓力的對照；若未在30日內羽化則標記驗收未通過。','- 無上帝視角：新增死蟲需先扣既有活昆蟲，未知地點只能鄰接探索，工蟻不可讀全局庫存，禁止GM輸入強制補糧、死亡或保命。','- 假設的每日死亡率、孵化期、雨量、土壤濕潤和工蟻覓食能力不是實測精度。','- 進階分巢、蟻道壅塞、兵蟻比例、不同巢間物資交換、寄生感染等規格尚未全部數值化；100/1000工蟻僅是單日效能煙霧測試，不是千蟻30日科學生態驗收。','','**GitHub main仍在Day14，審閱確認之前不更新或推進。**'])
(OUT/'review-report.md').write_text('\n'.join(out)+'\n')
print(f'Exported {len(entries)} tagged parameters and {len(rows)} baseline days')
