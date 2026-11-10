// 自托管插件：把 browser-extension/ 打成一个带签名的 CRX3，并生成 Chrome/Edge 的更新清单
// updates.xml。控制器（cybion.ntnl.io）把这两个文件 Host 在 /extensions/ 下，浏览器就会按
// manifest 里的 update_url 自己升级。
//
// 用法：node scripts/pack.mjs
// 产出：release/cybion.crx、release/updates.xml、release/manifest.json
//
// 只用 node 内置模块 + 系统 zip：CRX3 = 「12 字节头 + protobuf 头 + 普通 zip」，签名是
// RSA-SHA256，所以不需要 Chrome 参与，也不受有没有显示器影响（CI 里很关键）。
import { execFileSync } from "node:child_process"
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const release = path.join(root, "release")
// 私钥绝不能落在 release/ 里：那个目录会被编进二进制、通过 HTTP 对外提供。
const keys = path.join(root, ".keys")
const keyPath = path.join(keys, "cybion-extension.pem")
const stage = path.join(release, "stage")
const archive = path.join(release, "cybion.zip")
const UPDATE_URL = "https://cybion.ntnl.io/extensions/updates.xml"
const COBASE_URL = "https://cybion.ntnl.io/extensions/cybion.crx"
// 打进 CRX 的文件：多一个少一个都会改变插件行为，所以在这里写死，不用通配。
const ENTRIES = ["manifest.json", "sidepanel.html", "sidepanel.js", "src", "icons"]

/** 扩展 id = sha256(公钥 DER) 的前 16 字节，每半字节映射到 a-p。 */
function extensionId(publicKeyDer) {
  return [...createHash("sha256").update(publicKeyDer).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("")
}

function varint(value) {
  const bytes = []
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80)
    value = Math.floor(value / 128)
  }
  bytes.push(value)
  return Buffer.from(bytes)
}

/** protobuf 的 `bytes` 字段（wire type 2）。 */
function bytesField(fieldNumber, data) {
  return Buffer.concat([varint(fieldNumber * 8 + 2), varint(data.length), data])
}

function uint32le(value) {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

/** 组织清单 SignedData { bytes crx_id = 1 }。Chrome 用这个 id 核对「这把钥匙配这个扩展」。 */
function signedHeaderData(crxId) {
  return bytesField(1, crxId)
}

// Chrome 的签名口径：固定前缀 + 头长度 + 头 + 归档本身。
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "latin1")

function signaturePayload(headerData, archiveData) {
  return Buffer.concat([
    SIGNATURE_CONTEXT,
    uint32le(headerData.length),
    headerData,
    archiveData,
  ])
}

/** 读回来验证：签名对得上、id 与清单一致，才算打包成功。 */
function verifyCrx(crx, expectedId) {
  if (crx.subarray(0, 4).toString("latin1") !== "Cr24" || crx.readUInt32LE(4) !== 3) {
    throw new Error("产物不是 CRX3")
  }
  const headerEnd = 12 + crx.readUInt32LE(8)
  const headerData = crx.subarray(12, headerEnd)
  const archiveData = crx.subarray(headerEnd)
  const proofs = new Map(readFields(headerData))
  const keyProof = Buffer.from(proofs.get(2))
  const signed = Buffer.from(proofs.get(10000))
  const proofFields = new Map(readFields(keyProof))
  const publicKey = Buffer.from(proofFields.get(1))
  const signature = Buffer.from(proofFields.get(2))
  const id = createHash("sha256").update(publicKey).digest().subarray(0, 16)
  if (id.toString("hex") !== expectedId.toString("hex")) throw new Error("CRX 里的公钥与私钥不匹配")
  const ok = verify(
    "sha256",
    signaturePayload(signed, archiveData),
    { key: createPublicKey({ key: publicKey, format: "der", type: "spki" }), padding: 1 },
    signature,
  )
  if (!ok) throw new Error("CRX 签名验证失败")
  if (archiveData.subarray(0, 2).toString("latin1") !== "PK") throw new Error("CRX 里的归档不是 zip")
}

function readFields(buffer) {
  const fields = new Map()
  let index = 0
  const readVarint = () => {
    let shift = 0
    let value = 0
    for (;;) {
      const byte = buffer[index++]
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return value
      shift += 7
    }
  }
  while (index < buffer.length) {
    const key = readVarint()
    if ((key & 7) !== 2) throw new Error(`不认识的 protobuf wire type ${key & 7}`)
    const length = readVarint()
    fields.set(Math.floor(key / 8), buffer.subarray(index, index + length))
    index += length
  }
  return fields
}

await mkdir(release, { recursive: true })
await mkdir(keys, { recursive: true })

// 1. 密钥：第一次跑就生成，之后一直用同一把。换了它，扩展 id 就变，老用户就收不到升级。
let privateKeyPem
try {
  privateKeyPem = await readFile(keyPath, "utf8")
} catch {
  if (process.env.CI) {
    // CI 上静默生成新钥匙 = 发布一个所有老用户都升不上去的新扩展，必须炸掉。
    throw new Error(`CI 上找不到签名私钥 ${keyPath}（应由 CYBION_EXTENSION_KEY 写进来）`)
  }
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  })
  privateKeyPem = privateKey
  await writeFile(keyPath, privateKeyPem, { mode: 0o600 })
  console.log(`已生成签名密钥 ${path.relative(process.cwd(), keyPath)}（别入库，换了它扩展 id 会变）`)
}
const privateKey = createPrivateKey(privateKeyPem)
const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" })
const crxId = createHash("sha256").update(publicKeyDer).digest().subarray(0, 16)
const id = extensionId(publicKeyDer)

// 2. 把公钥写进 manifest：id 从此与路径无关，换机器、换目录都不变。
const manifestPath = path.join(root, "manifest.json")
const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
if (manifest.key && manifest.key !== publicKeyDer.toString("base64")) {
  // 仓库里的公钥和这次签名用的私钥不是一对：再发出去就是另一个扩展 id。
  throw new Error("manifest.json 里的 key 与签名私钥不匹配：要么轮换私钥，要么修正仓库里的 key")
}
manifest.key = publicKeyDer.toString("base64")
manifest.update_url = UPDATE_URL
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

// 3. 打个干净的暂存目录（别把 release/ 自己打进去），再用系统 zip 归档。
await rm(stage, { recursive: true, force: true })
for (const entry of ENTRIES) {
  await cp(path.join(root, entry), path.join(stage, entry), { recursive: true })
}
await rm(archive, { force: true })
execFileSync("zip", ["-q", "-r", "-X", archive, ...ENTRIES], { cwd: stage })
const archiveData = await readFile(archive)
await rm(stage, { recursive: true, force: true })
await rm(archive, { force: true })

// 4. 组装 CRX3：AsymmetricKeyProof{public_key, signature} + signed_header_data + 归档。
const headerData = signedHeaderData(crxId)
const signature = sign("sha256", signaturePayload(headerData, archiveData), privateKey)
const proof = Buffer.concat([bytesField(1, publicKeyDer), bytesField(2, signature)])
const header = Buffer.concat([bytesField(2, proof), bytesField(10000, headerData)])
const crx = Buffer.concat([Buffer.from("Cr24", "latin1"), uint32le(3), uint32le(header.length), header, archiveData])
verifyCrx(crx, crxId)
await writeFile(path.join(release, "cybion.crx"), crx, { mode: 0o644 })

// 5. 更新清单：浏览器只看这个文件决定要不要升级。
const updates = `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${COBASE_URL}' version='${manifest.version}'/>
  </app>
</gupdate>
`
await writeFile(path.join(release, "updates.xml"), updates)
await cp(manifestPath, path.join(release, "manifest.json"))

console.log(`扩展 id: ${id}`)
console.log(`版本: ${manifest.version}`)
console.log("产出: release/cybion.crx, release/updates.xml")
console.log("\n安装（Edge，需要一次管理员权限，之后自动升级）:")
console.log(`  sudo defaults write /Library/Preferences/com.microsoft.Edge.plist ExtensionInstallForcelist -array "${id};${UPDATE_URL}"`)
