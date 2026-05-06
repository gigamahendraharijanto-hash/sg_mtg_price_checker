$ErrorActionPreference = "Stop"

$port = 3000
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$public = Join-Path $root "public"

$stores = @(
  @{ id = "hideout"; name = "Hideout"; baseUrl = "https://hideoutcg.com"; adapter = "shopify"; shipping = @{ name = "Registered Mail (Singles)"; price = 4.0; source = "shopify-shipping-rates" } },
  @{ id = "games-haven"; name = "Games Haven"; baseUrl = "https://www.gameshaventcg.com"; adapter = "shopify"; shipping = @{ name = "Regular Mail"; price = 2.5; source = "shopify-shipping-rates" } },
  @{ id = "mtg-asia"; name = "MTG Asia"; baseUrl = "https://www.mtg-asia.com"; adapter = "shopify"; shipping = @{ name = "Regular tracked mail"; price = 2.5; minSubtotal = 15.0; source = "published-faq-fallback" } },
  @{ id = "grey-ogre"; name = "Grey Ogre"; baseUrl = "https://www.greyogregames.com"; adapter = "shopify"; shipping = @{ name = "Standard Package"; price = 3.0; source = "shopify-shipping-rates" } },
  @{ id = "one-mtg"; name = "One MTG"; baseUrl = "https://onemtg.com.sg"; adapter = "shopify"; shipping = @{ name = "Tracked Shipping"; price = 3.0; source = "shopify-shipping-rates" } }
)

function Send-Text($response, [int]$status, [string]$contentType, [string]$body) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $response.StatusCode = $status
  $response.ContentType = $contentType
  try { $response.ContentLength64 = $bytes.Length } catch {}
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

function Send-Json($response, [int]$status, $body) {
  $json = $body | ConvertTo-Json -Depth 12
  Send-Text $response $status "application/json; charset=utf-8" $json
}

function Strip-Tags([string]$html) {
  if ([string]::IsNullOrWhiteSpace($html)) { return "" }
  $text = [regex]::Replace($html, "<script[\s\S]*?</script>", "", "IgnoreCase")
  $text = [regex]::Replace($text, "<style[\s\S]*?</style>", "", "IgnoreCase")
  $text = [regex]::Replace($text, "<[^>]+>", " ")
  $text = [regex]::Replace($text, "\s+", " ").Trim()
  return [System.Net.WebUtility]::HtmlDecode($text)
}

function Get-BodyField([string]$body, [string]$label) {
  if ([string]::IsNullOrWhiteSpace($body)) { return "" }
  $escaped = [regex]::Escape($label)
  $match = [regex]::Match($body, "<td>\s*$escaped\s*:\s*</td>\s*<td>(.*?)</td>", "IgnoreCase")
  if (-not $match.Success) { return "" }
  return Strip-Tags $match.Groups[1].Value
}

function Convert-ToAsciiText([string]$value) {
  if ($null -eq $value) { $value = "" }
  $normalized = $value.Normalize([Text.NormalizationForm]::FormD)
  $result = [regex]::Replace($normalized, "\p{Mn}", "")
  $result = $result.Replace([string][char]0x2019, "'")
  $result = $result.Replace([string][char]0x2018, "'")
  $result = $result.Replace([string][char]0x0060, "'")
  $result = $result.Replace([string][char]0x00B4, "'")
  $result = $result.Replace([string][char]0x201C, '"')
  $result = $result.Replace([string][char]0x201D, '"')
  $result = $result.Replace([string][char]0x2013, "-")
  $result = $result.Replace([string][char]0x2014, "-")
  return $result
}

function Normalize-Name([string]$value) {
  return (Convert-ToAsciiText $value).ToLowerInvariant() -replace "\s+", " "
}

function Test-PlayableName([string]$productName, [string]$query) {
  $name = (Normalize-Name $productName).Trim()
  $wanted = (Normalize-Name $query).Trim()
  return $name -eq $wanted -or $name.StartsWith("$wanted (") -or $name.StartsWith("$wanted [")
}

function Get-LimitedStock($value) {
  if ($null -eq $value) { return $null }
  try {
    $stock = [int][double]$value
    if ($stock -gt 0) { return $stock }
  } catch {}
  return $null
}

function Get-CartSupport($store, $variantId) {
  if ($store.adapter -eq "shopify" -and $variantId) { return "direct" }
  return "listing"
}

function Get-ShopifyCartUrl($store, $variantId, [int]$quantity) {
  if (-not $variantId) { return "" }
  $safeQuantity = [Math]::Max($quantity, 1)
  return ([System.Uri]::new([System.Uri]$store.baseUrl, "/cart/$($variantId):$safeQuantity")).ToString()
}

function Get-CartUrlForQuantity($item, [int]$quantity) {
  $store = @($stores | Where-Object { $_.id -eq $item.storeId } | Select-Object -First 1)
  if ($store.Count -gt 0 -and $store[0].adapter -eq "shopify" -and $item.variantId) {
    return Get-ShopifyCartUrl $store[0] $item.variantId $quantity
  }
  if ($item.cartUrl) { return $item.cartUrl }
  return $item.url
}

function Get-QuantityForCart([int]$requested, $maxQuantity) {
  $wanted = [Math]::Max($requested, 1)
  if ($maxQuantity) { return [Math]::Min($wanted, [int]$maxQuantity) }
  return $wanted
}

function Get-ArtKey($item) {
  return (Normalize-Name "$($item.image) $($item.title) $($item.set)").Trim()
}

function Get-EmbeddedInventoryFromHtml([string]$html, $variantId) {
  if (-not $variantId -or [string]::IsNullOrWhiteSpace($html)) { return $null }
  $escaped = [regex]::Escape([string]$variantId)
  $match = [regex]::Match($html, """$escaped""\s*:\s*\{[\s\S]*?""inventory_quantity""\s*:\s*(-?\d+)", "IgnoreCase")
  if ($match.Success) { return Get-LimitedStock $match.Groups[1].Value }

  $optionMatch = [regex]::Match($html, "<option[^>]*value=[""']$escaped[""'][^>]*data-stock=[""'](-?\d+)[""']", "IgnoreCase")
  if ($optionMatch.Success) { return Get-LimitedStock $optionMatch.Groups[1].Value }

  return $null
}

function Get-EmbeddedShopifyStock($store, $handle, $variantId) {
  if (-not $handle -or -not $variantId) { return $null }
  try {
    $html = Invoke-WebRequest -Uri "$($store.baseUrl)/products/$handle" -UseBasicParsing -Headers @{ "User-Agent" = "SG MTG Price Finder/0.1 local" } -TimeoutSec 20 | Select-Object -ExpandProperty Content
    return Get-EmbeddedInventoryFromHtml $html $variantId
  } catch {}
  return $null
}

function Parse-Decklist([string]$inputText) {
  $map = @{}
  foreach ($raw in ($inputText -split "\r?\n")) {
    $line = ($raw -replace "//.*$", "" -replace "#.*$", "").Trim()
    if (-not $line -or $line -match "^(deck|sideboard|commander|maybeboard)$") { continue }
    $line = $line -replace "^SB:\s*", ""
    $line = $line -replace "\s+\([A-Z0-9]{2,6}\)\s+\d+[a-z]?$", ""
    $line = $line -replace "\s+\[[^\]]+\]$", ""
    $quantity = 1
    $name = $line
    $match = [regex]::Match($line, "^(\d+)x?\s+(.+)$", "IgnoreCase")
    if ($match.Success) {
      $quantity = [int]$match.Groups[1].Value
      $name = $match.Groups[2].Value.Trim()
    }
    $name = (Convert-ToAsciiText $name).Trim()
    if (-not $name) { continue }
    $key = (Normalize-Name $name).Trim()
    if ($map.ContainsKey($key)) {
      $map[$key].quantity += $quantity
    } else {
      $map[$key] = [ordered]@{ name = $name; quantity = $quantity }
    }
  }
  return @($map.Values)
}

function To-ShopifyProduct($product, $store, [string]$query) {
  $title = [System.Net.WebUtility]::HtmlDecode([string]$product.title)
  $minRaw = $product.price_min
  if ($null -eq $minRaw) { $minRaw = $product.price }
  if ($null -eq $minRaw) { $minRaw = 0 }
  $maxRaw = $product.price_max
  if ($null -eq $maxRaw) { $maxRaw = $product.price }
  if ($null -eq $maxRaw) { $maxRaw = 0 }
  $priceMin = [double]$minRaw
  $priceMax = [double]$maxRaw
  $body = [string]$product.body
  $set = Get-BodyField $body "Set"
  $rarity = Get-BodyField $body "Rarity"
  $cardName = [regex]::Replace($title, "\s*\[[^\]]+\]\s*$", "")
  if (-not (Test-PlayableName $cardName $query)) { return $null }

  if (-not $set) {
    $setMatch = [regex]::Match($title, "\[([^\]]+)\]\s*$")
    if ($setMatch.Success) { $set = $setMatch.Groups[1].Value }
  }

  $urlPath = [string]$product.url
  if (-not $urlPath) { $urlPath = "/products/$($product.handle)" }
  $fullUrl = [System.Uri]::new([System.Uri]$store.baseUrl, $urlPath).ToString()

  $image = ""
  if ($product.featured_image -and $product.featured_image.url) {
    $image = [string]$product.featured_image.url
  } elseif ($product.image) {
    $image = [string]$product.image
  }

  $tags = @()
  if ($product.tags) { $tags = @($product.tags) }

  $cheapestVariant = $null
  try {
    $detailUrl = "$($store.baseUrl)/products/$($product.handle).js"
    $detail = Invoke-RestMethod -Uri $detailUrl -Headers @{ "User-Agent" = "SG MTG Price Finder/0.1 local" } -TimeoutSec 20
    $availableVariants = @($detail.variants | Where-Object { $_.available } | ForEach-Object {
      $variantTitle = $_.public_title
      if ($null -eq $variantTitle) { $variantTitle = $_.title }
      [ordered]@{
        id = $_.id
        title = [string]$variantTitle
        price = ([double]$_.price / 100)
        stock = Get-LimitedStock $_.inventory_quantity
      }
    } | Sort-Object price)
    if ($availableVariants.Count -gt 0) { $cheapestVariant = $availableVariants[0] }
  } catch {}

  if (-not $cheapestVariant -and -not [bool]$product.available) { return $null }
  $cheapestPrice = if ($cheapestVariant) { [double]$cheapestVariant.price } else { $priceMin }
  $variantId = if ($cheapestVariant) { $cheapestVariant.id } else { "" }
  $maxQuantity = if ($cheapestVariant) { $cheapestVariant.stock } else { $null }
  $cartSupport = Get-CartSupport $store $variantId
  $cartUrl = if ($variantId) { Get-ShopifyCartUrl $store $variantId 1 } else { $fullUrl }

  return [ordered]@{
    id = "$($store.id):$($product.id)"
    store = $store.name
    storeId = $store.id
    title = $title
    cardName = $cardName
    set = $set
    type = [string]$product.type
    rarity = $rarity
    available = [bool]$product.available
    priceMin = $cheapestPrice
    priceMax = $cheapestPrice
    priceLabel = "`$$($cheapestPrice.ToString("0.00")) SGD"
    condition = if ($cheapestVariant) { $cheapestVariant.title } else { "" }
    variantId = $variantId
    maxQuantity = $maxQuantity
    handle = [string]$product.handle
    cartSupport = $cartSupport
    cartUrl = $cartUrl
    image = $image
    url = $fullUrl
    tags = $tags
  }
}

function Search-ShopifyStore($store, [string]$query, [int]$limit) {
  $encoded = [System.Uri]::EscapeDataString($query)
  $url = "$($store.baseUrl)/search/suggest.json?q=$encoded&resources[type]=product&resources[limit]=$limit"
  $headers = @{ "User-Agent" = "SG MTG Price Finder/0.1 local" }
  $data = Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 20
  $products = @($data.resources.results.products)
  $results = @()

  foreach ($product in $products) {
    $normalized = To-ShopifyProduct $product $store $query
    if (-not $normalized) { continue }
    $isMtg = $normalized.type.ToLowerInvariant().Contains("mtg")
    if (-not $isMtg) {
      foreach ($tag in $normalized.tags) {
        if ([string]$tag -match "magic") { $isMtg = $true }
      }
    }
    if ($isMtg) { $results += $normalized }
  }

  return $results
}

function Search-MoxStore($store, [string]$query) {
  $encoded = [System.Uri]::EscapeDataString($query)
  $data = Invoke-RestMethod -Uri "$($store.baseUrl)/api/products?search=$encoded" -Headers @{ "User-Agent" = "SG MTG Price Finder/0.1 local" } -TimeoutSec 20
  $results = @()
  foreach ($product in @($data)) {
    if (-not (Test-PlayableName ([string]$product.title) $query)) { continue }
    $conditions = @($product.conditions | Where-Object { [double]$_.price -gt 0 -and [int]$_.stocks -gt 0 } | Sort-Object { [double]$_.price })
    if ($conditions.Count -eq 0) { continue }
    $cheapest = $conditions[0]
    $productUrl = "$($store.baseUrl)/products/$($product.id)"
    $results += [ordered]@{
      id = "$($store.id):$($product.id)"
      store = $store.name
      storeId = $store.id
      title = [string]$product.title
      cardName = [string]$product.title
      set = if ($product.expansion) { [string]$product.expansion } else { [string]$product.ck_edition }
      type = [string]$product.type_code
      rarity = if ($product.rarity) { [string]$product.rarity } else { [string]$product.rarity_code }
      available = $true
      priceMin = [double]$cheapest.price
      priceMax = [double]$cheapest.price
      priceLabel = "`$$(([double]$cheapest.price).ToString("0.00")) SGD"
      condition = [string]$cheapest.code
      stock = [int]$cheapest.stocks
      maxQuantity = [int]$cheapest.stocks
      cartSupport = Get-CartSupport $store $null
      cartUrl = $productUrl
      image = [string]$product.image_path
      url = $productUrl
      tags = @()
    }
  }
  return $results
}

function Search-DuellersStore($store, [string]$query) {
  $encoded = [System.Uri]::EscapeDataString($query)
  $html = Invoke-WebRequest -Uri "$($store.baseUrl)/products/search?search_text=$encoded" -UseBasicParsing -Headers @{ "User-Agent" = "SG MTG Price Finder/0.1 local" } -TimeoutSec 20 | Select-Object -ExpandProperty Content
  $rows = [regex]::Matches($html, "<tr>[\s\S]*?</tr>", "IgnoreCase")
  $results = @()
  foreach ($rowMatch in $rows) {
    $row = $rowMatch.Value
    $nameMatch = [regex]::Match($row, "<a[^>]+class=[""'][^""']*fw-bold[^""']*[""'][^>]*href=[""']([^""']+)[""'][^>]*>([\s\S]*?)</a>", "IgnoreCase")
    if (-not $nameMatch.Success) { continue }
    $name = Strip-Tags $nameMatch.Groups[2].Value
    if (-not (Test-PlayableName $name $query)) { continue }
    if ($row -match "Out of Stock") { continue }
    $priceMatch = [regex]::Match($row, "S\$\s*([0-9]+(?:\.[0-9]+)?)", "IgnoreCase")
    if (-not $priceMatch.Success) { continue }
    $editionMatch = [regex]::Match($row, "<strong>([^<]+)</strong>", "IgnoreCase")
    $imgMatch = [regex]::Match($row, "<img[^>]+src=[""']([^""']+)[""']", "IgnoreCase")
    $price = [double]$priceMatch.Groups[1].Value
    $productUrl = ([System.Uri]::new([System.Uri]$store.baseUrl, $nameMatch.Groups[1].Value)).ToString()
    $results += [ordered]@{
      id = "$($store.id):$($nameMatch.Groups[1].Value)"
      store = $store.name
      storeId = $store.id
      title = $name
      cardName = $name
      set = if ($editionMatch.Success) { [System.Net.WebUtility]::HtmlDecode($editionMatch.Groups[1].Value) } else { "" }
      type = ""
      rarity = ""
      available = $true
      priceMin = $price
      priceMax = $price
      priceLabel = "`$$($price.ToString("0.00")) SGD"
      condition = ""
      maxQuantity = $null
      cartSupport = Get-CartSupport $store $null
      cartUrl = $productUrl
      image = if ($imgMatch.Success) { ([System.Uri]::new([System.Uri]$store.baseUrl, $imgMatch.Groups[1].Value)).ToString() } else { "" }
      url = $productUrl
      tags = @()
    }
  }
  return $results
}

function Search-Store($store, [string]$query, [int]$limit) {
  if ($store.adapter -eq "mox") { return Search-MoxStore $store $query }
  if ($store.adapter -eq "duellers") { return Search-DuellersStore $store $query }
  return Search-ShopifyStore $store $query $limit
}

function Add-StockForListing($item) {
  if (-not $item -or $item.missing -or $item.maxQuantity -or -not $item.variantId) { return }
  $store = @($stores | Where-Object { $_.id -eq $item.storeId } | Select-Object -First 1)
  if ($store.Count -eq 0 -or $store[0].adapter -ne "shopify") { return }
  $handle = [string]$item.handle
  if (-not $handle -and $item.url -match "/products/([^/?#]+)") { $handle = $Matches[1] }
  $stock = Get-EmbeddedShopifyStock $store[0] $handle $item.variantId
  if ($stock) { $item.maxQuantity = $stock }
}

function Add-StockForListings($items) {
  $seen = @{}
  foreach ($item in @($items)) {
    if (-not $item -or $item.missing) { continue }
    $key = "$($item.storeId):$($item.variantId)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    Add-StockForListing $item
  }
}

function Cheapest-ByStore($results) {
  $out = @()
  foreach ($store in $stores) {
    $best = @($results | Where-Object { $_.storeId -eq $store.id } | Sort-Object { [double]$_["priceMin"] }, { [string]$_["title"] } | Select-Object -First 1)
    if ($best.Count -gt 0) {
      $out += $best[0]
    } else {
      $out += [ordered]@{ store = $store.name; storeId = $store.id; missing = $true }
    }
  }
  return $out
}

function Cheapest-ArtOptions($results, [int]$limit = 8) {
  $byArt = @{}
  foreach ($result in $results) {
    $key = Get-ArtKey $result
    if (-not $byArt.ContainsKey($key) -or [double]$result.priceMin -lt [double]$byArt[$key].priceMin) {
      $byArt[$key] = $result
    }
  }
  return @($byArt.Values | Sort-Object { [double]$_["priceMin"] }, { [string]$_["store"] }, { [string]$_["title"] } | Select-Object -First $limit)
}

function Build-CheckoutPlan($cardResults) {
  $byStore = @{}
  $missing = @()

  foreach ($card in $cardResults) {
    $best = $card.bestOverall
    if (-not $best) {
      $missing += [ordered]@{ name = $card.name; quantity = $card.quantity }
      continue
    }

    $quantity = Get-QuantityForCart ([int]$card.quantity) $best.maxQuantity
    if ($quantity -lt [int]$card.quantity) {
      $missing += [ordered]@{
        name = $card.name
        quantity = ([int]$card.quantity - $quantity)
        reason = "Only $quantity available from $($best.store)"
      }
    }

    $storeId = [string]$best.storeId
    if (-not $byStore.ContainsKey($storeId)) {
      $byStore[$storeId] = [ordered]@{
        store = $best.store
        storeId = $storeId
        items = @()
        total = 0.0
      }
    }

    $lineTotal = [double]$best.priceMin * $quantity
    $byStore[$storeId].total = [double]$byStore[$storeId].total + $lineTotal
    $byStore[$storeId].items += [ordered]@{
      id = $best.id
      name = $card.name
      requestedQuantity = $card.quantity
      quantity = $quantity
      maxQuantity = $best.maxQuantity
      unitPrice = [double]$best.priceMin
      lineTotal = $lineTotal
      title = $best.title
      condition = $best.condition
      set = $best.set
      image = $best.image
      url = $best.url
      cartUrl = Get-CartUrlForQuantity $best $quantity
      cartSupport = if ($best.cartSupport) { $best.cartSupport } else { "listing" }
      variantId = if ($best.variantId) { $best.variantId } else { "" }
    }
  }

  $groups = @($byStore.Values | Sort-Object { -[double]$_["total"] }, { [string]$_["store"] })
  $total = 0.0
  foreach ($group in $groups) { $total += [double]$group.total }

  return [ordered]@{
    groups = $groups
    missing = $missing
    total = $total
  }
}

function Handle-Search($context) {
  $request = $context.Request
  $response = $context.Response
  $query = [string]$request.QueryString["q"]
  if ($request.HttpMethod -eq "POST") {
    $reader = [System.IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
    $body = $reader.ReadToEnd()
    $reader.Close()
    try {
      $parsed = $body | ConvertFrom-Json
      if ($parsed.q) { $query = [string]$parsed.q }
      elseif ($parsed.decklist) { $query = [string]$parsed.decklist }
    } catch {
      if ($body) { $query = $body }
    }
  }
  $limit = 15
  if ($request.QueryString["limit"]) {
    $limit = [Math]::Min([Math]::Max([int]$request.QueryString["limit"], 1), 20)
  }

  if ([string]::IsNullOrWhiteSpace($query)) {
    Send-Json $response 400 @{ error = "Enter a card name to search." }
    return
  }

  $cards = Parse-Decklist $query
  $cardResults = @()
  $errors = @()
  foreach ($card in $cards) {
    $results = @()
    foreach ($store in $stores) {
      try {
        $results += Search-Store $store $card.name $limit
      } catch {
        $errors += @{ card = $card.name; store = $store.name; message = $_.Exception.Message }
      }
    }
    $results = @($results | Sort-Object { [double]$_["priceMin"] }, { [string]$_["store"] }, { [string]$_["title"] })
    $storesForCard = Cheapest-ByStore $results
    Add-StockForListings @($storesForCard | Where-Object { -not $_.missing })
    $printings = Cheapest-ArtOptions $results
    $best = @($storesForCard | Where-Object { -not $_.missing } | Sort-Object { [double]$_["priceMin"] }, { [string]$_["store"] } | Select-Object -First 1)
    $bestTotal = $null
    $selectedQuantity = 0
    if ($best.Count -gt 0) {
      $selectedQuantity = Get-QuantityForCart ([int]$card.quantity) $best[0].maxQuantity
      $bestTotal = [double]$best[0].priceMin * $selectedQuantity
    }
    $cardResults += [ordered]@{
      name = $card.name
      quantity = $card.quantity
      requestedQuantity = $card.quantity
      selectedQuantity = $selectedQuantity
      stores = $storesForCard
      printings = $printings
      listings = @($results | Select-Object -First 30)
      bestOverall = if ($best.Count -gt 0) { $best[0] } else { $null }
      bestTotal = $bestTotal
    }
  }

  $checkoutPlan = Build-CheckoutPlan $cardResults
  $flat = @()
  foreach ($card in $cardResults) {
    $flat += @($card.stores | Where-Object { -not $_.missing })
  }
  Send-Json $response 200 @{
    query = $query
    cards = $cards
    searchedAt = (Get-Date).ToUniversalTime().ToString("o")
    stores = @($stores | ForEach-Object { @{ id = $_.id; name = $_.name; baseUrl = $_.baseUrl; shipping = $_.shipping } })
    errors = $errors
    cardResults = $cardResults
    checkoutPlan = $checkoutPlan
    results = $flat
  }
}

function Serve-Static($context) {
  $request = $context.Request
  $response = $context.Response
  $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
  if ($path -eq "/") { $path = "/index.html" }

  $relative = $path.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
  $file = [System.IO.Path]::GetFullPath((Join-Path $public $relative))
  $publicFull = [System.IO.Path]::GetFullPath($public)

  if (-not $file.StartsWith($publicFull)) {
    Send-Text $response 403 "text/plain; charset=utf-8" "Forbidden"
    return
  }

  if (-not (Test-Path $file -PathType Leaf)) {
    Send-Text $response 404 "text/plain; charset=utf-8" "Not found"
    return
  }

  $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
  $type = switch ($ext) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "text/javascript; charset=utf-8" }
    default { "application/octet-stream" }
  }
  $bytes = [System.IO.File]::ReadAllBytes($file)
  $response.StatusCode = 200
  $response.ContentType = $type
  $response.Headers.Set("Cache-Control", "no-store")
  try { $response.ContentLength64 = $bytes.Length } catch {}
  $response.OutputStream.Write($bytes, 0, $bytes.Length)
  $response.OutputStream.Close()
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$port/")

try {
  $listener.Start()
  Write-Host ""
  Write-Host "SG MTG Price Finder running at http://localhost:$port"
  Write-Host "Keep this PowerShell window open. Press Ctrl+C to stop."
  Write-Host ""

  while ($listener.IsListening) {
    $context = $listener.GetContext()
    try {
      if ($context.Request.Url.AbsolutePath -eq "/api/search") {
        Handle-Search $context
      } elseif ($context.Request.Url.AbsolutePath -eq "/api/stores") {
        Send-Json $context.Response 200 @{ stores = @($stores | ForEach-Object { @{ id = $_.id; name = $_.name; baseUrl = $_.baseUrl; shipping = $_.shipping } }) }
      } else {
        Serve-Static $context
      }
    } catch {
      try { Send-Json $context.Response 500 @{ error = $_.Exception.Message } } catch {}
    }
  }
} finally {
  if ($listener.IsListening) { $listener.Stop() }
  $listener.Close()
}
