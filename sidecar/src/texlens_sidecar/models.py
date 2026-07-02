from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class BlockType(str, Enum):
    title = "title"
    paragraph = "paragraph"
    formula = "formula"
    table = "table"
    image = "image"
    unknown = "unknown"


class RecognitionMode(str, Enum):
    auto = "auto"
    formula = "formula"
    table = "table"
    text = "text"


class OCRBlock(BaseModel):
    id: str
    page: int = 1
    block_type: BlockType = BlockType.unknown
    bbox: List[float] = Field(default_factory=lambda: [0, 0, 1, 1])
    text: str = ""
    latex: str = ""
    confidence: Optional[float] = None
    crop_path: Optional[str] = None
    raw: Dict[str, Any] = Field(default_factory=dict)


class PageResult(BaseModel):
    page: int
    image_path: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    blocks: List[OCRBlock] = Field(default_factory=list)


class DocumentResult(BaseModel):
    id: str
    title: str
    source_type: str
    source_path: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    status: str = "completed"
    pages: List[PageResult] = Field(default_factory=list)
    latex: str = ""
    raw: Dict[str, Any] = Field(default_factory=dict)
    thumbnail_path: Optional[str] = None
    original_copy_path: Optional[str] = None
    metrics: Dict[str, Any] = Field(default_factory=dict)


class OCRRequest(BaseModel):
    path: str
    source_type: str = "image"
    mode: RecognitionMode = RecognitionMode.auto
    title: Optional[str] = None


class OCRTaskRequest(BaseModel):
    path: str
    mode: RecognitionMode = RecognitionMode.auto
    title: Optional[str] = None


class OCRTaskPage(BaseModel):
    page: int
    status: str = "pending"
    image_path: Optional[str] = None
    error: Optional[str] = None
    duration_ms: Optional[float] = None


class OCRTaskState(BaseModel):
    id: str
    source_path: str
    source_type: str = "pdf"
    mode: RecognitionMode = RecognitionMode.auto
    title: Optional[str] = None
    status: str = "pending"
    current_page: Optional[int] = None
    total_pages: int = 0
    completed_pages: int = 0
    pages: List[OCRTaskPage] = Field(default_factory=list)
    failed_pages: List[OCRTaskPage] = Field(default_factory=list)
    cancel_requested: bool = False
    document_id: Optional[str] = None
    document: Optional[DocumentResult] = None
    error: Optional[str] = None
    created_at: datetime
    updated_at: datetime


class RerunBlockRequest(BaseModel):
    document_id: str
    block_id: str
    mode: RecognitionMode = RecognitionMode.auto


class RepairRequest(BaseModel):
    latex: str
    compiler_log: str = ""


class RepairSuggestion(BaseModel):
    original: str
    repaired: str
    changes: List[str] = Field(default_factory=list)
    requires_confirmation: bool = True


class ServiceState(BaseModel):
    running: bool
    pid: Optional[int] = None
    endpoint: str
    healthy: bool = False
    last_error: Optional[str] = None
    raw_status: Dict[str, Any] = Field(default_factory=dict)


class GpuMetric(BaseModel):
    timestamp: datetime
    name: str = "unknown"
    memory_used_mib: Optional[int] = None
    memory_total_mib: Optional[int] = None
    utilization_percent: Optional[int] = None


class ObservabilitySnapshot(BaseModel):
    service: ServiceState
    gpu: List[GpuMetric] = Field(default_factory=list)
    queue_depth: int = 0
    cache: Dict[str, Any] = Field(default_factory=dict)
    recent_errors: List[str] = Field(default_factory=list)
    request_durations_ms: List[float] = Field(default_factory=list)


class RuntimeSettings(BaseModel):
    model_dir: str
    fastdeploy_python: str
    fastdeploy_args: List[str] = Field(default_factory=list)
    history_days: int
    cleanup_policy: str
    hotkey: str
    prompt_templates: Dict[str, str] = Field(default_factory=dict)
    latex_template: str
    latex_engine: str


class RuntimeSettingsUpdate(BaseModel):
    model_dir: Optional[str] = None
    fastdeploy_python: Optional[str] = None
    fastdeploy_args: Optional[List[str]] = None
    history_days: Optional[int] = None
    cleanup_policy: Optional[str] = None
    hotkey: Optional[str] = None
    prompt_templates: Optional[Dict[str, str]] = None
    latex_template: Optional[str] = None
    latex_engine: Optional[str] = None
