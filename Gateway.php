<?php
ini_set('max_execution_time', 300);
set_time_limit(300);
function sendJsonResponse($statusCode, $data) {
    http_response_code($statusCode);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

function validateResponse($data){
    if(!$data) return false;

    if(isset($data['choices']) && is_array($data['choices']) && count($data['choices']) > 0){
      $content = $data['choices'][0]['message']['content'] ?? null;
      return $content !== null && $content !== '' && $content !== 0;
    }

    return false;
}

$requestUri = $_SERVER['REQUEST_URI'];
$scriptName = $_SERVER['SCRIPT_NAME'];
$path = str_replace($scriptName, '', $requestUri);
$path = parse_url($path, PHP_URL_PATH);
$path = $path ?: '/';

switch($method = $_SERVER['REQUEST_METHOD']){
  case 'OPTIONS':
    http_response_code(200);
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, x-portkey-config');
    exit;
  case 'GET':
    switch($path){
      case '/':
        http_response_code(200);
        echo 'Portkey Gateway Activo';
        exit;
      case '/health':
        sendJsonResponse(200, ['status' => 'healthy', 'timestamp' => date('c'), 'version' => '1.0.0']);
        exit;
    }
    break;
  case 'POST':
    if($path != '/v1/chat/completions') sendJsonResponse(404, ['error' => 'Ruta no encontrada']);
    $configHeader = $_SERVER['HTTP_X_PORTKEY_CONFIG'] ?? null;
    if(!$configHeader) sendJsonResponse(400, ['error' => 'Falta x-portkey-config']);

    $config = json_decode($configHeader, true);
    if(json_last_error() !== JSON_ERROR_NONE) sendJsonResponse(400, ['error' => 'JSON inválido en x-portkey-config']);

    if(!isset($config['targets']) || !is_array($config['targets'])) sendJsonResponse(400, ['error' => 'Configuración inválida: falta targets']);

    $strategy = $config['strategy'] ?? [];
    $fallbackCodes = $strategy['on_status_codes'] ?? [];
    $request_timeout_ms = $config['request_timeout'] ?? 45000;

    $rawBody = file_get_contents('php://input');
    $originalBody = json_decode($rawBody, true);
    if(json_last_error() !== JSON_ERROR_NONE) $originalBody = [];

    foreach($config['targets'] as $target){
      if(!isset($target['custom_host'], $target['api_key'])){
        error_log("Target inválido: falta custom_host o api_key");
        continue;
      }

      $custom_host = rtrim($target['custom_host'], '/');
      $api_key = $target['api_key'];
      $override_params = $target['override_params'] ?? [];
      $output_guardrails = $target['output_guardrails'] ?? [];
      $hasGuardrail = in_array('pg-notnul-a1afe8', $output_guardrails);

      $requestBody = array_merge($originalBody, $override_params);
      $jsonBody = json_encode($requestBody);

      $ch = curl_init();
      curl_setopt($ch, CURLOPT_URL, "$custom_host/chat/completions");
      curl_setopt($ch, CURLOPT_POST, true);
      curl_setopt($ch, CURLOPT_POSTFIELDS, $jsonBody);
      curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
      curl_setopt($ch, CURLOPT_HTTPHEADER, ["Content-Type: application/json", "Authorization: Bearer $api_key", "User-Agent: TeleCharsAI/1.0"]);

      curl_setopt($ch, CURLOPT_TIMEOUT_MS, $request_timeout_ms);
      curl_setopt($ch, CURLOPT_CONNECTTIMEOUT_MS, $request_timeout_ms);
      curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
      curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

      $responseBody = curl_exec($ch);
      $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
      $curlError = curl_error($ch);
      curl_close($ch);

      if($curlError){
        error_log("Error con $custom_host: $curlError");
        continue;
      }

      $responseData = json_decode($responseBody, true);
      if(json_last_error() !== JSON_ERROR_NONE){
        error_log("Respuesta no JSON de $custom_host");
        continue;
      }

      if($httpCode >= 400 && in_array($httpCode, $fallbackCodes)){
        error_log("Código $httpCode en fallbackCodes para $custom_host, continuando…");
        continue;
      }

      if($httpCode >= 200 && $httpCode < 300){
        if($hasGuardrail && !validateResponse($responseData)){
          error_log("Guardrail fallido para $custom_host");
          continue;
        }
        sendJsonResponse($httpCode, $responseData);
      }

      sendJsonResponse($httpCode, $responseData);
    }
}

if($path != '/v1/chat/completions') sendJsonResponse(404, ['error' => 'Ruta no encontrada']);

sendJsonResponse(503, ['error' => 'Todos los targets fallaron', 'message' => 'Ningún proveedor respondió correctamente o pasó el guardrail']);