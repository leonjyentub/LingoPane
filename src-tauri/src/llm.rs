use futures_util::{
    future::{AbortHandle, Abortable},
    stream, StreamExt,
};
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::Duration,
};

use crate::limits::{MAX_TRANSLATION_BLOCKS_PER_PAGE, MAX_TRANSLATION_CHARS_PER_PAGE};

const KEYCHAIN_SERVICE: &str = "com.leonjye.parallelpdf.llm";

fn active_translations() -> &'static Mutex<HashMap<u64, AbortHandle>> {
    static ACTIVE_TRANSLATIONS: OnceLock<Mutex<HashMap<u64, AbortHandle>>> = OnceLock::new();
    ACTIVE_TRANSLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub provider_id: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TranslationBlock {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRequest {
    pub config: ProviderConfig,
    pub source_language: String,
    pub target_language: String,
    pub blocks: Vec<TranslationBlock>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub blocks: Vec<TranslationBlock>,
    pub model: String,
}

#[derive(Debug, Deserialize)]
struct ModelList {
    data: Vec<ModelRecord>,
}

#[derive(Debug, Deserialize)]
struct ModelRecord {
    id: String,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("無法建立 HTTP client：{error}"))
}

fn endpoint(base_url: &str, path: &str) -> Result<String, String> {
    let base_url = base_url.trim().trim_end_matches('/');
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err("Base URL 必須以 http:// 或 https:// 開頭".into());
    }
    Ok(format!("{base_url}/{path}"))
}

fn keychain_entry(provider_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, provider_id)
        .map_err(|error| format!("無法存取 macOS Keychain：{error}"))
}

fn stored_api_key(provider_id: &str) -> String {
    keychain_entry(provider_id)
        .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
        .unwrap_or_default()
}

fn authorized(request: RequestBuilder, provider_id: &str) -> RequestBuilder {
    let api_key = stored_api_key(provider_id);
    if api_key.is_empty() {
        request
    } else {
        request.bearer_auth(api_key)
    }
}

async fn response_error(response: reqwest::Response) -> String {
    let status = response.status();
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response.text().await.unwrap_or_default();
    if let Ok(value) = serde_json::from_str::<Value>(&body) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .or_else(|| value.get("error").and_then(Value::as_str))
        {
            let error_type = value
                .pointer("/error/metadata/error_type")
                .and_then(Value::as_str);
            let provider_code = value.pointer("/error/metadata/provider_code");
            let mut details = Vec::new();
            if let Some(error_type) = error_type {
                details.push(format!("類型：{error_type}"));
            }
            if let Some(provider_code) = provider_code {
                details.push(format!("上游代碼：{provider_code}"));
            }
            if let Some(retry_after) = retry_after.as_deref() {
                details.push(format!("建議等待：{retry_after} 秒"));
            }
            let suffix = if details.is_empty() {
                String::new()
            } else {
                format!("（{}）", details.join("；"))
            };
            return format!("服務回傳 {status}：{message}{suffix}");
        }
    }
    let summary: String = body.chars().take(240).collect();
    format!("服務回傳 {status}：{summary}")
}

#[tauri::command]
pub fn save_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    let entry = keychain_entry(&provider_id)?;
    if api_key.trim().is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(api_key.trim())
        .map_err(|error| format!("無法將 API Key 寫入 macOS Keychain：{error}"))
}

#[tauri::command]
pub async fn list_models(config: ProviderConfig) -> Result<Vec<String>, String> {
    let url = endpoint(&config.base_url, "models")?;
    let response = authorized(client()?.get(url), &config.provider_id)
        .send()
        .await
        .map_err(|error| format!("無法連線到模型服務：{error}"))?;

    if !response.status().is_success() {
        return Err(response_error(response).await);
    }

    let mut models = response
        .json::<ModelList>()
        .await
        .map_err(|error| format!("模型列表格式不正確：{error}"))?
        .data
        .into_iter()
        .map(|model| model.id)
        .collect::<Vec<_>>();
    models.sort();
    Ok(models)
}

#[tauri::command]
pub async fn test_connection(config: ProviderConfig) -> Result<String, String> {
    let models = list_models(config).await?;
    Ok(format!("連線成功，共找到 {} 個模型", models.len()))
}

fn parse_json_content(content: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str(content.trim()) {
        return Ok(value);
    }

    let start = content.find('{');
    let end = content.rfind('}');
    match (start, end) {
        (Some(start), Some(end)) if start < end => serde_json::from_str(&content[start..=end])
            .map_err(|error| format!("模型回應不是有效 JSON：{error}")),
        _ => Err("模型沒有回傳可解析的 JSON 翻譯結果".into()),
    }
}

fn parse_chat_response(bytes: &[u8]) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
        return Ok(value);
    }

    let text = String::from_utf8_lossy(bytes);
    let normalized = text.trim().trim_start_matches('\u{feff}');
    if let Ok(value) = serde_json::from_str::<Value>(normalized) {
        return Ok(value);
    }

    // Some OpenAI-compatible servers may answer with SSE even when streaming
    // was not requested. Reconstruct the assistant content from delta chunks.
    let mut streamed_content = String::new();
    let mut streamed_model = String::new();
    let mut saw_sse = false;
    for line in normalized.lines() {
        let Some(data) = line.trim().strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        saw_sse = true;
        let chunk = serde_json::from_str::<Value>(data)
            .map_err(|error| format!("oMLX SSE 區塊不是有效 JSON：{error}"))?;
        if streamed_model.is_empty() {
            streamed_model = chunk
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
        }
        if let Some(content) = chunk
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .or_else(|| {
                chunk
                    .pointer("/choices/0/message/content")
                    .and_then(Value::as_str)
            })
        {
            streamed_content.push_str(content);
        }
    }
    if saw_sse && !streamed_content.is_empty() {
        return Ok(json!({
            "model": streamed_model,
            "choices": [{ "message": { "content": streamed_content } }]
        }));
    }

    let parse_error = serde_json::from_str::<Value>(normalized).unwrap_err();
    let preview: String = normalized.chars().take(360).collect();
    Err(format!(
        "模型回應不是有效 JSON（{parse_error}）。回應預覽：{}",
        preview.replace(['\n', '\r'], " ")
    ))
}

fn is_translate_gemma(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("translategemma")
        || model.contains("translate-gemma")
        || model.contains("translate_gemma")
}

fn assistant_content(response: &Value) -> Result<String, String> {
    if let Some(text) = response.pointer("/choices/0/text").and_then(Value::as_str) {
        return Ok(text.trim().to_string());
    }
    let content = response
        .pointer("/choices/0/message/content")
        .ok_or_else(|| "模型回應缺少 choices[0].message.content".to_string())?;
    if let Some(text) = content.as_str() {
        return Ok(text.trim().to_string());
    }
    if let Some(parts) = content.as_array() {
        let mut text = String::new();
        for part in parts {
            if let Some(fragment) = part
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
            {
                text.push_str(fragment);
            }
        }
        if !text.is_empty() {
            return Ok(text.trim().to_string());
        }
    }
    Err("模型回應的 message.content 不是文字".into())
}

fn translate_gemma_language_name(code: &str) -> &str {
    let lower = code.to_ascii_lowercase();
    if lower == "zh-tw" || lower == "zh_hant" {
        return "Traditional Chinese";
    }
    let base = lower.split(['-', '_']).next().unwrap_or(code);
    match base {
        "en" => "English",
        "ja" => "Japanese",
        "zh" => "Simplified Chinese",
        _ => code,
    }
}

fn translate_gemma_prompt(source_code: &str, target_code: &str, text: &str) -> String {
    let source_name = translate_gemma_language_name(source_code);
    let target_name = translate_gemma_language_name(target_code);
    let target_hint = if target_code.to_ascii_lowercase().starts_with("zh") {
        if target_code.eq_ignore_ascii_case("zh-tw") || target_code.eq_ignore_ascii_case("zh_hant")
        {
            "\nIMPORTANT: You MUST output Traditional Chinese characters (繁體中文). Do NOT use Simplified Chinese characters."
        } else {
            "\nIMPORTANT: You MUST output Simplified Chinese characters (简体中文). Do NOT use Traditional Chinese characters."
        }
    } else {
        ""
    };
    format!(
        "<bos><start_of_turn>user\nYou are a professional {source_name} ({source_code}) to {target_name} ({target_code}) translator. Your goal is to accurately convey the meaning and nuances of the original {source_name} text while adhering to {target_name} grammar, vocabulary, and cultural sensitivities.{target_hint}\nProduce only the {target_name} translation, without any additional explanations or commentary. Please translate the following {source_name} text into {target_name}:\n\n\n{}<end_of_turn>\n<start_of_turn>model\n",
        text.trim()
    )
}

async fn translate_gemma_block(
    client: Client,
    config: ProviderConfig,
    source_language: String,
    target_language: String,
    block: TranslationBlock,
) -> Result<TranslationBlock, String> {
    // oMLX's current OpenAI ContentPart schema drops TranslateGemma's custom
    // language fields before rendering the model template. Render the model's
    // bundled chat_template.jinja equivalently and use the raw completions API.
    let prompt = translate_gemma_prompt(&source_language, &target_language, &block.text);
    let max_tokens = (block.text.chars().count() * 2).clamp(96, 768);
    let body = json!({
        "model": config.model,
        "stream": false,
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stop": ["<end_of_turn>", "<eos>"],
        "prompt": prompt
    });
    let url = endpoint(&config.base_url, "completions")?;
    let response = authorized(client.post(url).json(&body), &config.provider_id)
        .send()
        .await
        .map_err(|error| format!("TranslateGemma 區塊 {} 請求失敗：{error}", block.id))?;
    if !response.status().is_success() {
        return Err(format!(
            "TranslateGemma 區塊 {}：{}",
            block.id,
            response_error(response).await
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("無法讀取 TranslateGemma 區塊 {} 回應：{error}", block.id))?;
    let response = parse_chat_response(&bytes)?;
    let translated_text = assistant_content(&response)?;
    if translated_text.is_empty() {
        return Err(format!("TranslateGemma 沒有翻譯區塊 {}", block.id));
    }
    Ok(TranslationBlock {
        id: block.id,
        text: translated_text,
    })
}

async fn translate_with_translate_gemma(
    request: TranslationRequest,
) -> Result<TranslationResult, String> {
    if request.source_language.eq_ignore_ascii_case("auto") {
        return Err(
            "TranslateGemma 需要明確的來源語言，請在設定中選擇 English、日本語或繁體中文".into(),
        );
    }

    let model = request.config.model.clone();
    let http_client = client()?;
    let block_count = request.blocks.len();
    let results = stream::iter(request.blocks.into_iter().enumerate())
        .map(|(index, block)| {
            let http_client = http_client.clone();
            let config = request.config.clone();
            let source_language = request.source_language.clone();
            let target_language = request.target_language.clone();
            async move {
                translate_gemma_block(http_client, config, source_language, target_language, block)
                    .await
                    .map(|translated| (index, translated))
            }
        })
        .buffer_unordered(3)
        .collect::<Vec<_>>()
        .await;

    let mut ordered = vec![None; block_count];
    for result in results {
        let (index, block) = result?;
        ordered[index] = Some(block);
    }
    let blocks = ordered
        .into_iter()
        .enumerate()
        .map(|(index, block)| {
            block.ok_or_else(|| format!("TranslateGemma 遺漏第 {} 個翻譯區塊", index + 1))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(TranslationResult { blocks, model })
}

async fn translate_blocks_inner(request: TranslationRequest) -> Result<TranslationResult, String> {
    if request.config.model.trim().is_empty() {
        return Err("請先選擇翻譯模型".into());
    }
    if request.blocks.is_empty() {
        return Err("這一頁沒有可翻譯文字".into());
    }
    if request.blocks.len() > MAX_TRANSLATION_BLOCKS_PER_PAGE {
        return Err("單頁文字區塊過多，請縮小翻譯範圍".into());
    }

    let total_chars = request
        .blocks
        .iter()
        .map(|block| block.text.chars().count())
        .sum::<usize>();
    if total_chars > MAX_TRANSLATION_CHARS_PER_PAGE {
        return Err("單頁文字超過目前的 60,000 字元限制".into());
    }

    if is_translate_gemma(&request.config.model) {
        return translate_with_translate_gemma(request).await;
    }

    let input = json!({ "blocks": request.blocks });
    let system_prompt = format!(
        "You are a professional document translator. Translate from {} to {}. Preserve meaning, terminology, numbers, citations, and inline symbols. Return JSON only in this exact shape: {{\"blocks\":[{{\"id\":\"original id\",\"text\":\"translated text\"}}]}}. Keep every input id exactly once and in the same order. Do not merge, omit, explain, or add blocks.",
        request.source_language, request.target_language
    );

    let body = json!({
        "model": request.config.model,
        "temperature": 0.1,
        "stream": false,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": input.to_string() }
        ]
    });

    let url = endpoint(&request.config.base_url, "chat/completions")?;
    let response = authorized(client()?.post(url).json(&body), &request.config.provider_id)
        .send()
        .await
        .map_err(|error| format!("翻譯請求失敗：{error}"))?;

    if !response.status().is_success() {
        return Err(response_error(response).await);
    }

    let response_bytes = response
        .bytes()
        .await
        .map_err(|error| format!("無法讀取模型回應內容：{error}"))?;
    let response_body = parse_chat_response(&response_bytes)?;
    let content = assistant_content(&response_body)?;
    let translated = parse_json_content(&content)?;
    let blocks = serde_json::from_value::<Vec<TranslationBlock>>(
        translated
            .get("blocks")
            .cloned()
            .ok_or_else(|| "模型回應缺少 blocks".to_string())?,
    )
    .map_err(|error| format!("翻譯區塊格式不正確：{error}"))?;

    if blocks.len() != request.blocks.len() {
        return Err(format!(
            "模型回傳 {} 個區塊，但預期為 {} 個",
            blocks.len(),
            request.blocks.len()
        ));
    }

    for (source, translated) in request.blocks.iter().zip(blocks.iter()) {
        if source.id != translated.id {
            return Err(format!(
                "模型改動了區塊 ID：預期 {}，實際 {}",
                source.id, translated.id
            ));
        }
    }

    Ok(TranslationResult {
        blocks,
        model: request.config.model,
    })
}

#[tauri::command]
pub fn cancel_translation(translation_id: u64) -> Result<bool, String> {
    let handle = active_translations()
        .lock()
        .map_err(|_| "翻譯取消狀態無法鎖定".to_string())?
        .remove(&translation_id);
    if let Some(handle) = handle {
        handle.abort();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
pub async fn translate_blocks(
    request: TranslationRequest,
    translation_id: u64,
) -> Result<TranslationResult, String> {
    let (abort_handle, abort_registration) = AbortHandle::new_pair();
    {
        let mut active = active_translations()
            .lock()
            .map_err(|_| "翻譯執行狀態無法鎖定".to_string())?;
        if let Some(previous) = active.insert(translation_id, abort_handle) {
            previous.abort();
        }
    }

    let result = Abortable::new(translate_blocks_inner(request), abort_registration).await;
    if let Ok(mut active) = active_translations().lock() {
        active.remove(&translation_id);
    }
    result.map_err(|_| "翻譯已取消".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_openai_paths_without_double_slashes() {
        assert_eq!(
            endpoint("http://localhost:8000/v1/", "models").unwrap(),
            "http://localhost:8000/v1/models"
        );
    }

    #[test]
    fn rejects_non_http_provider_urls() {
        assert!(endpoint("file:///tmp/models", "models").is_err());
    }

    #[test]
    fn parses_plain_and_fenced_json_responses() {
        let plain = parse_json_content(r#"{"blocks":[]}"#).unwrap();
        assert!(plain.get("blocks").is_some());

        let fenced = parse_json_content("```json\n{\"blocks\":[]}\n```").unwrap();
        assert!(fenced.get("blocks").is_some());
    }

    #[test]
    fn parses_chat_json_with_utf8_bom() {
        let value =
            parse_chat_response(b"\xEF\xBB\xBF{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}")
                .unwrap();
        assert_eq!(value.pointer("/choices/0/message/content").unwrap(), "ok");
    }

    #[test]
    fn reconstructs_unexpected_sse_responses() {
        let sse = concat!(
            "data: {\"model\":\"local\",\"choices\":[{\"delta\":{\"content\":\"{\\\"blocks\\\":\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"[]}\"}}]}\n\n",
            "data: [DONE]\n"
        );
        let value = parse_chat_response(sse.as_bytes()).unwrap();
        assert_eq!(
            value.pointer("/choices/0/message/content").unwrap(),
            "{\"blocks\":[]}"
        );
    }

    #[test]
    fn recognizes_translate_gemma_model_variants() {
        assert!(is_translate_gemma("translategemma-12b-it-4bit"));
        assert!(is_translate_gemma("google/translate-gemma-12b"));
        assert!(!is_translate_gemma("gemma-4-12b-it"));
    }

    #[test]
    fn renders_translate_gemma_native_prompt() {
        let prompt = translate_gemma_prompt("en", "zh-TW", "Hello");
        assert!(prompt.contains("English (en) to Traditional Chinese (zh-TW) translator"));
        assert!(prompt.contains("Traditional Chinese characters (繁體中文)"));
        assert!(prompt.contains("Hello<end_of_turn>"));
        assert!(prompt.ends_with("<start_of_turn>model\n"));
    }

    #[test]
    fn renders_simplified_chinese_hint() {
        let prompt = translate_gemma_prompt("en", "zh", "Hello");
        assert!(prompt.contains("Simplified Chinese characters (简体中文)"));
    }
}
