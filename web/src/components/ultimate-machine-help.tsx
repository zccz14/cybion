import { useState } from "react"
import { CircleHelpIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"

const copy = {
  en: {
    helpLabel: "About the Ultimate Machine",
    title: "Where the “Ultimate Machine” comes from",
    description: "The name comes from Claude Shannon’s desk box: the “Ultimate Machine” that only switches itself off.",
    intro: "Bell Labs, 1952. AI pioneer Marvin Minsky built a small box with a switch, a hinge, and a single “finger”: flip the switch on, the lid pops open, the finger reaches out to flip the switch back off, then slides back inside. He gave it a grand name — the “Ultimate Machine” — because its only function is to switch itself off.",
    caption: "Flip it on, and it does exactly one thing — switches itself off.",
    origin: "The joke spread from the desk of his mentor at Bell Labs, information-theory pioneer Claude Shannon, who kept one of these boxes there. Science-fiction author Arthur C. Clarke saw it and wrote:",
    quote: "There is something unspeakably sinister about a machine that does nothing — absolutely nothing — except switch itself off.",
    attribution: "Arthur C. Clarke",
    tie: "Every machine on this page carries on the same joke: perfectly quiet by default, it only appears when a check fails, and falls silent again once the command returns 0.",
    close: "Got it",
  },
  zh: {
    helpLabel: "关于「终极机器」",
    title: "「终极机器」的来历",
    description: "名字来自香农办公桌上的盒子：「终极机器」——唯一的功能就是把自己关掉。",
    intro: "1952 年，贝尔实验室。AI 先驱马文·明斯基（Marvin Minsky）做了个小盒子：开关、铰链、一根「手指」——按下开关，盒盖弹开，手指伸出来把开关拨回去，然后缩回盒内。他给它起了个响亮的名字：「终极机器」（The Ultimate Machine）。毕竟它唯一的功能，就是把自己关掉。",
    caption: "打开开关，它只会做一件事——把自己关掉。",
    origin: "让这个梗流传开来的，是明斯基的导师、信息论之父克劳德·香农（Claude Shannon）：他把一台放在自己的办公桌上；科幻作家阿瑟·克拉克（Arthur C. Clarke）在那里见到它后写道：",
    quote: "一台什么都不做、只会把自己关掉的机器，透着一种说不出的诡异。",
    attribution: "阿瑟·克拉克",
    tie: "这里的每台机器也延续着同一种幽默：平时保持沉默，只在检查失败时现身；命令回到 0 之后，再一次安静下来。",
    close: "知道了",
  },
}

export function UltimateMachineHelp({ language }: { language: "zh" | "en" }) {
  const text = copy[language]
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="icon-sm" aria-label={text.helpLabel} title={text.helpLabel}>
          <CircleHelpIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{text.title}</DialogTitle>
          <DialogDescription className="sr-only">{text.description}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{text.intro}</p>
        <div className="space-y-2">
          <UltimateMachineMemeScene />
          <p className="text-center text-xs text-muted-foreground italic">{text.caption}</p>
        </div>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">{text.origin}</p>
          <blockquote className="border-l-2 pl-3 text-sm text-muted-foreground italic">
            “{text.quote}”
            <span className="mt-1 block text-xs not-italic">— {text.attribution}</span>
          </blockquote>
          <p className="text-sm text-muted-foreground">{text.tie}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{text.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// A looping, self-contained re-enactment: the switch flips on, the lid opens,
// a finger emerges, pushes the switch back off and retreats — then silence.
// Motion lives in styles.css (um-* keyframes); positions are tuned relative to
// the 176px scene so the parts keep meeting even when the dialog resizes.
function UltimateMachineMemeScene() {
  return (
    <div className="um-scene relative mx-auto h-[176px] w-full max-w-[380px] overflow-hidden rounded-xl border bg-muted/30" aria-hidden="true">
      <div className="absolute bottom-6 left-1/2 z-10 h-[84px] w-[176px] -translate-x-1/2 rounded-lg border bg-card shadow-sm">
        <div className="um-led absolute bottom-[12px] left-[16px] size-2 rounded-full bg-emerald-500" />
        <div className="um-lid absolute -top-[7px] left-[30px] h-[10px] w-[60px] rounded-[3px] border bg-card" />
        <div className="absolute -top-[46px] right-[26px] h-[46px] w-[30px]">
          <div className="um-lever absolute bottom-[7px] left-[11.5px] h-[36px] w-[7px] rounded-full bg-foreground/70" />
          <div className="absolute bottom-[3px] left-[5px] h-[7px] w-[20px] rounded-[3px] border bg-card" />
        </div>
      </div>
      <div className="um-swing absolute bottom-[108px] left-[191px] z-0 h-[52px] w-[18px]">
        <div className="um-rod absolute bottom-0 left-[5.5px] h-full w-[7px] rounded-full bg-foreground/70" />
        <div className="um-fist absolute left-0 top-0 size-[18px] rounded-full bg-foreground/70" />
      </div>
    </div>
  )
}
