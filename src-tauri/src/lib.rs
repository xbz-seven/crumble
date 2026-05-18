use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::Argon2;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;

// magic header bytes that identify a .crumbs file
// if the first 8 bytes aren't CRUMBLES we bail immediately
const MAGIC: &[u8; 8] = b"CRUMBLES";
const FORMAT_VERSION: u8 = 2;
// 32 bytes salt for argon2 — yes it's fixed, no i don't care
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Serialize, Deserialize, Clone)]
struct PackageMeta {
    files: Vec<FileMeta>,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileMeta {
    path: String,
    id: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntryInfo {
    pub path: String,
    pub id: String,
    pub is_duplicate: bool,
}

// TODO: actually use this for progress reporting
// was going to emit events during pack/unpack but never got around to it
#[allow(dead_code)]
enum ProgressEvent {
    FileStarted(String),
    FileDone(String, u64),
    Done,
}

struct PackedFile {
    path: String,
    data: Vec<u8>,
}

fn encode_payload(files: &[PackedFile], meta: &PackageMeta) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let n = files.len() as u32;
    buf.extend_from_slice(&n.to_le_bytes());
    for f in files {
        let path_bytes = f.path.as_bytes();
        let plen = path_bytes.len() as u32;
        let dlen = f.data.len() as u64;
        buf.extend_from_slice(&plen.to_le_bytes());
        buf.extend_from_slice(path_bytes);
        buf.extend_from_slice(&dlen.to_le_bytes());
        buf.extend_from_slice(&f.data);
    }
    let meta_json = serde_json::to_vec(meta).map_err(|e| e.to_string())?;
    let mlen = meta_json.len() as u32;
    buf.extend_from_slice(&mlen.to_le_bytes());
    buf.extend_from_slice(&meta_json);
    Ok(buf)
}

fn decode_payload(data: &[u8]) -> Result<(Vec<PackedFile>, PackageMeta), String> {
    let mut pos = 0;
    if data.len() < 4 {
        return Err("truncated payload".into());
    }
    let num_files = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
    pos += 4;

    let mut files = Vec::with_capacity(num_files);
    for _ in 0..num_files {
        if pos + 4 > data.len() {
            return Err("truncated path length".into());
        }
        let plen = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
        pos += 4;
        if pos + plen > data.len() {
            return Err("truncated path".into());
        }
        let path =
            String::from_utf8(data[pos..pos + plen].to_vec()).map_err(|e| e.to_string())?;
        pos += plen;
        if pos + 8 > data.len() {
            return Err("truncated data length".into());
        }
        let dlen = u64::from_le_bytes(data[pos..pos + 8].try_into().unwrap()) as usize;
        pos += 8;
        if pos + dlen > data.len() {
            return Err("truncated data".into());
        }
        let file_data = data[pos..pos + dlen].to_vec();
        pos += dlen;
        files.push(PackedFile {
            path,
            data: file_data,
        });
    }

    if pos + 4 > data.len() {
        return Err("truncated meta length".into());
    }
    let mlen = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    if pos + mlen > data.len() {
        return Err("truncated meta".into());
    }
    let meta: PackageMeta =
        serde_json::from_slice(&data[pos..pos + mlen]).map_err(|e| e.to_string())?;
    Ok((files, meta))
}

// argon2 gives us 40 bytes — first 32 are the AES key, last 8 are the XOR shuffle seed
// saves having to generate a separate random seed for the obfuscation layer
fn derive_keys(password: &str, salt: &[u8]) -> Result<([u8; 32], u64), String> {
    let mut output = [0u8; 40];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut output)
        .map_err(|e| format!("key derivation failed: {}", e))?;

    let mut aes_key = [0u8; 32];
    aes_key.copy_from_slice(&output[..32]);
    let mut seed_bytes = [0u8; 8];
    seed_bytes.copy_from_slice(&output[32..40]);
    let seed = u64::from_le_bytes(seed_bytes);

    Ok((aes_key, seed))
}

// XOR obfuscation layer sandwiched between zstd and AES
// means even if someone cracks the AES key they still have to deal with
// a compressed + shuffled blob. overkill? probably. keeping it anyway.
fn obfuscate_bytes(data: &mut [u8], seed: u64) {
    use rand::{RngCore, SeedableRng};
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let mut keystream = vec![0u8; data.len()];
    rng.fill_bytes(&mut keystream);
    for i in 0..data.len() {
        data[i] ^= keystream[i];
    }
}

fn collect_files(paths: Vec<PathBuf>) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    let mut files = Vec::new();
    for path in paths {
        let path = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        if path.is_dir() {
            for entry in walkdir::WalkDir::new(&path) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().is_file() {
                    let full = entry.path().to_path_buf();
                    let relative = full
                        .strip_prefix(&path)
                        .map_err(|e| e.to_string())?
                        .to_path_buf();
                    files.push((relative, full));
                }
            }
        } else if path.is_file() {
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_os_string()
                .into();
            files.push((name, path));
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn read_encrypted(source: &str, password: &str) -> Result<(Vec<u8>, u8), String> {
    let src_path = PathBuf::from(source);
    let mut file =
        std::fs::File::open(&src_path).map_err(|e| format!("cannot open file: {}", e))?;

    let mut magic = [0u8; 8];
    file.read_exact(&mut magic).map_err(|e| e.to_string())?;
    if &magic != MAGIC {
        return Err("not a valid .crumbs file".into());
    }

    let mut version = [0u8; 1];
    file.read_exact(&mut version).map_err(|e| e.to_string())?;

    let mut salt = [0u8; SALT_LEN];
    file.read_exact(&mut salt).map_err(|e| e.to_string())?;

    let mut nonce_bytes = [0u8; NONCE_LEN];
    file.read_exact(&mut nonce_bytes).map_err(|e| e.to_string())?;

    let mut encrypted = Vec::new();
    file.read_to_end(&mut encrypted).map_err(|e| e.to_string())?;

    let (aes_key, shuffle_seed) = derive_keys(password, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("cipher init: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let payload = cipher
        .decrypt(nonce, &encrypted[..])
        .map_err(|_| String::from("decryption failed – wrong password?"))?;

    let mut compressed = payload;
    // format v1 didn't have the XOR layer, v2 added it
    // kept the check so old files still unpack
    if version[0] >= 2 {
        obfuscate_bytes(&mut compressed, shuffle_seed);
    }

    let data =
        zstd::decode_all(&compressed[..]).map_err(|e| format!("decompress failed: {}", e))?;

    Ok((data, version[0]))
}

fn read_and_decrypt(
    source: &str,
    password: &str,
) -> Result<(Vec<PackedFile>, PackageMeta), String> {
    let (raw, _ver) = read_encrypted(source, password)?;
    let (files, meta) = decode_payload(&raw)?;
    Ok((files, meta))
}

fn write_crumbs(
    output: &str,
    password: &str,
    payload: &[u8],
    _meta: &PackageMeta,
) -> Result<(), String> {
    let compressed =
        zstd::encode_all(payload, 22).map_err(|e| format!("compress failed: {}", e))?;

    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);

    let (aes_key, shuffle_seed) = derive_keys(password, &salt)?;

    let mut shuffled = compressed;
    obfuscate_bytes(&mut shuffled, shuffle_seed);

    let cipher =
        Aes256Gcm::new_from_slice(&aes_key).map_err(|e| format!("cipher init: {}", e))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let encrypted = cipher
        .encrypt(nonce, &shuffled[..])
        .map_err(|e| format!("encryption failed: {}", e))?;

    let out_path = PathBuf::from(output);
    let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
    out.write_all(MAGIC).map_err(|e| e.to_string())?;
    out.write_all(&[FORMAT_VERSION]).map_err(|e| e.to_string())?;
    out.write_all(&salt).map_err(|e| e.to_string())?;
    out.write_all(&nonce_bytes).map_err(|e| e.to_string())?;
    out.write_all(&encrypted).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn pack_files(
    sources: Vec<String>,
    output: String,
    password: String,
) -> Result<String, String> {
    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let files = collect_files(source_paths)?;

    if files.is_empty() {
        return Err("no files found to pack".into());
    }

    let mut packed_files = Vec::new();
    let mut file_metas = Vec::new();
    let mut total_size: u64 = 0;

    for (relative, full) in &files {
        let data = std::fs::read(full).map_err(|e| e.to_string())?;
        let path_str = relative.to_string_lossy().to_string();
        let file_id = uuid::Uuid::new_v4().to_string();
        total_size += data.len() as u64;
        file_metas.push(FileMeta {
            path: path_str.clone(),
            id: file_id,
        });
        packed_files.push(PackedFile {
            path: path_str,
            data,
        });
    }

    let meta = PackageMeta {
        files: file_metas,
    };

    let payload = encode_payload(&packed_files, &meta)?;
    let out_path_str = output.clone();
    write_crumbs(&output, &password, &payload, &meta)?;

    let out_size = std::fs::metadata(&out_path_str)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(format!(
        "Packed {} file(s) into {} (original: {:.2} KB → packed: {:.2} KB, {:.1}% of original)",
        files.len(),
        out_path_str,
        total_size as f64 / 1024.0,
        out_size as f64 / 1024.0,
        if total_size > 0 {
            out_size as f64 / total_size as f64 * 100.0
        } else {
            0.0
        }
    ))
}

#[tauri::command]
fn list_crumbs(source: String, password: String) -> Result<Vec<FileEntryInfo>, String> {
    let (raw, _ver) = read_encrypted(&source, &password)?;
    let (_files, meta) = decode_payload(&raw)?;

    let result: Vec<FileEntryInfo> = meta
        .files
        .iter()
        .map(|f| FileEntryInfo {
            path: f.path.clone(),
            id: f.id.clone(),
            is_duplicate: false,
        })
        .collect();

    Ok(result)
}

#[tauri::command]
fn unpack_selected(
    source: String,
    output_dir: String,
    password: String,
    selected: Vec<String>,
) -> Result<String, String> {
    let (files, _meta) = read_and_decrypt(&source, &password)?;
    let out_dir = PathBuf::from(&output_dir);

    let mut file_count = 0usize;

    for file in &files {
        if !selected.contains(&file.path) {
            continue;
        }

        let target = out_dir.join(&file.path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &file.data).map_err(|e| e.to_string())?;
        file_count += 1;
    }

    Ok(format!(
        "Extracted {} file(s) to {}",
        file_count,
        out_dir.display()
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            pack_files,
            list_crumbs,
            unpack_selected,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
