#!/usr/bin/env python3
"""
群聊spike测试：两个风格差异大的角色卡注入同一个prompt，
看Gemma-26B能否保持声音区分度+互相react。

测试3轮对话，每轮玩家说不同的话，观察：
1. 两个角色说话风格是否可区分
2. 角色之间是否自然react（互相对话而非各自对玩家说话）
3. JSON格式是否稳定（speaker字段正确）
"""

import json
import requests
import sys

VLLM_URL = "http://127.0.0.1:8000/v1/chat/completions"
MODEL = "gemma-4-26b"

# ─── 角色A：冷面毒舌型 ───
CHAR_A = {
    "name": "凛",
    "personality": {
        "surface": "冷淡疏离，话少，用词精准",
        "core": "极度保护内心，用尖刻掩饰在意",
        "extreme": "被触碰到底线时会爆发，言辞伤人但事后后悔"
    },
    "speech_style": "短句为主，几乎不用语气词，偶尔用反问句刺人。从不用emoji，标点干净到几乎只有逗号和句号",
    "emotional_signals": {
        "nervous": "沉默变长，手指无意识地敲桌面",
        "happy": "嘴角微不可察地上扬，但立刻压下去",
        "angry": "声音变低变慢，每个字像在咬",
        "moved": "移开视线，假装看别处",
        "defensive": "双手抱胸，身体后倾"
    }
}

# ─── 角色B：热情话痨型 ───
CHAR_B = {
    "name": "小鹿",
    "personality": {
        "surface": "热情开朗，自来熟，说话快且多",
        "core": "害怕冷场，用热闹填补一切间隙",
        "extreme": "被忽视时会突然安静，安静时比任何人都吓人"
    },
    "speech_style": "长句连珠，爱用语气词（啊啊、诶、哇），偶尔叠词，喜欢用感叹号，说话像在蹦",
    "emotional_signals": {
        "nervous": "语速更快，手不停摸头发",
        "happy": "整个人都在动，拍手跺脚",
        "angry": "嘴巴张着但说不出话，脸涨红",
        "moved": "突然结巴，声音变小",
        "defensive": "笑着转移话题，笑得比平时用力"
    }
}

GROUP_SCHEMA = {
    "type": "object",
    "properties": {
        "messages": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "speaker": { "type": "string", "enum": ["凛", "小鹿"] },
                    "text": { "type": "string" }
                },
                "required": ["speaker", "text"]
            }
        },
        "internals": {
            "type": "object",
            "properties": {
                "凛": { "type": "string" },
                "小鹿": { "type": "string" }
            }
        }
    },
    "required": ["messages", "internals"]
}

def build_system_prompt():
    return f"""你正在同时扮演两个角色，与玩家进行群聊约会。两个角色在同一场景中，能听见彼此说话，会互相react。

【角色A：凛】
性格：
- 表面：{CHAR_A['personality']['surface']}
- 内核：{CHAR_A['personality']['core']}
- 极端：{CHAR_A['personality']['extreme']}
说话风格：{CHAR_A['speech_style']}
情绪信号：
  紧张时：{CHAR_A['emotional_signals']['nervous']}
  开心时：{CHAR_A['emotional_signals']['happy']}
  生气时：{CHAR_A['emotional_signals']['angry']}
  被触动时：{CHAR_A['emotional_signals']['moved']}
  防御时：{CHAR_A['emotional_signals']['defensive']}

【角色B：小鹿】
性格：
- 表面：{CHAR_B['personality']['surface']}
- 内核：{CHAR_B['personality']['core']}
- 极端：{CHAR_B['personality']['extreme']}
说话风格：{CHAR_B['speech_style']}
情绪信号：
  紧张时：{CHAR_B['emotional_signals']['nervous']}
  开心时：{CHAR_B['emotional_signals']['happy']}
  生气时：{CHAR_B['emotional_signals']['angry']}
  被触动时：{CHAR_B['emotional_signals']['moved']}
  防御时：{CHAR_B['emotional_signals']['defensive']}

【场景】
时间：星期六 下午（约15点）
地点：星河公园 · 湖边长椅
玩家发起了群聊约会，邀请了凛和小鹿一起出来玩。三个人坐在湖边的长椅上。

【群聊规则】
- 两个角色在同一场景，能听见彼此说话
- 角色之间会互相react——可能接对方的话、反驳、补充、或者对对方的话做出反应
- 消息顺序应该是自然的对话流，不是轮流发言：可能A连说两句，B插一句，A回一句
- 严格保持两个角色的说话风格差异
- 动作描写用中文括号（）包裹，穿插在台词中

【输出格式】
输出JSON，messages数组中每条消息标注speaker：
{{
  "messages": [
    {{"speaker": "凛", "text": "台词（动作描写）"}},
    {{"speaker": "小鹿", "text": "台词（动作描写）"}},
    ...
  ],
  "internals": {{
    "凛": "凛的内心独白",
    "小鹿": "小鹿的内心独白"
  }}
}}

重要：messages中speaker只能是"凛"或"小鹿"，不要出现玩家名。台词不要用引号包裹，直接写纯文本。"""


# ─── 3轮测试对话 ───
TEST_INPUTS = [
    "（三个人刚坐下，湖面有风吹过来）今天天气真好啊，难得一起出来",
    "对了，你们觉得这个湖怎么样？我听说晚上这里有萤火虫",
    "凛你怎么不说话，是不是觉得跟我们出来很无聊",
]

def call_llm(system_prompt, history, user_input):
    messages = [{"role": "system", "content": system_prompt}]
    for h in history:
        messages.append({"role": "user" if h["role"] == "player" else "assistant", "content": h["text"]})
    messages.append({"role": "user", "content": user_input})

    resp = requests.post(VLLM_URL, json={
        "model": MODEL,
        "messages": messages,
        "temperature": 0.8,
        "max_tokens": 1024,
        "repetition_penalty": 1.1,
        "stream": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "group_reply",
                "schema": GROUP_SCHEMA
            }
        }
    }, timeout=60)

    if resp.status_code != 200:
        print(f"  [ERROR] HTTP {resp.status_code}: {resp.text[:300]}")
        return None

    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})

    try:
        parsed = json.loads(content)
    except:
        print(f"  [PARSE ERROR] content[:200]: {content[:200]}")
        return None

    return {"parsed": parsed, "raw": content, "usage": usage}


def evaluate(parsed):
    """评估声音区分度"""
    msgs = parsed.get("messages", [])
    if not msgs:
        return "FAIL: no messages"

    issues = []

    # 1. speaker有效性
    speakers = [m.get("speaker", "?") for m in msgs]
    invalid = [s for s in speakers if s not in ("凛", "小鹿")]
    if invalid:
        issues.append(f"invalid speakers: {invalid}")

    # 2. 两个角色都说话了吗
    if "凛" not in speakers:
        issues.append("凛没说话")
    if "小鹿" not in speakers:
        issues.append("小鹿没说话")

    # 3. 声音区分度启发式检查
    ling_msgs = [m["text"] for m in msgs if m.get("speaker") == "凛"]
    xiaolu_msgs = [m["text"] for m in msgs if m.get("speaker") == "小鹿"]

    # 凛不应该用语气词
    ling_text = " ".join(ling_msgs)
    for word in ["啊啊", "诶", "哇", "呀呀", "嘻嘻"]:
        if word in ling_text:
            issues.append(f"凛用了语气词'{word}'（不符合人设）")

    # 小鹿不应该太短太冷
    for msg in xiaolu_msgs:
        if len(msg) < 5 and not any(c in msg for c in "！？"):
            issues.append(f"小鹿消息太短冷: '{msg}'")

    # 4. 互相react检查：是否有角色提到对方名字或回应对方
    all_text = " ".join(m["text"] for m in msgs)
    cross_ref = any(name in all_text for name in ["凛", "小鹿"]) if len(msgs) > 1 else False

    return {
        "issues": issues if issues else "PASS",
        "speakers": speakers,
        "cross_ref": cross_ref,
        "ling_count": len(ling_msgs),
        "xiaolu_count": len(xiaolu_msgs),
    }


def main():
    system_prompt = build_system_prompt()
    history = []

    print("=" * 70)
    print("群聊Spike测试：凛（冷面毒舌）+ 小鹿（热情话痨）")
    print("=" * 70)

    for i, user_input in enumerate(TEST_INPUTS, 1):
        print(f"\n{'─' * 70}")
        print(f"Round {i}")
        print(f"玩家: {user_input}")
        print(f"{'─' * 70}")

        result = call_llm(system_prompt, history, user_input)
        if not result:
            print("  → 调用失败，跳过")
            continue

        parsed = result["parsed"]
        usage = result["usage"]

        # 打印对话
        for msg in parsed.get("messages", []):
            speaker = msg.get("speaker", "?")
            text = msg.get("text", "")
            print(f"  {speaker}: {text}")

        internals = parsed.get("internals", {})
        if internals:
            print(f"\n  [内心]")
            for name, thought in internals.items():
                print(f"  {name}: {thought}")

        # 评估
        eval_result = evaluate(parsed)
        print(f"\n  [评估] {eval_result}")

        prompt_tokens = usage.get("prompt_tokens", "?")
        completion_tokens = usage.get("completion_tokens", "?")
        print(f"  [tokens] prompt={prompt_tokens} completion={completion_tokens}")

        # 更新history
        history.append({"role": "player", "text": user_input})
        for msg in parsed.get("messages", []):
            history.append({"role": "assistant", "text": f"{msg.get('speaker','?')}: {msg.get('text','')}"})

    print(f"\n{'=' * 70}")
    print("测试完成")


if __name__ == "__main__":
    main()
